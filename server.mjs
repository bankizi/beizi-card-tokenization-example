import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Bancada local para testar o fluxo tokenizado de cartão em homologação.
 *
 * Por que existe um servidor, e não só uma página estática:
 *
 * 1. **O `client_secret` não pode ir para o navegador.** Ele fica aqui, em memória, e sai apenas
 *    na chamada de token para a Be.izi. A página nunca o recebe de volta.
 * 2. **CORS.** A API da Be.izi não autoriza uma origem `localhost`, então a chamada de transação
 *    precisa sair de um processo, não do navegador.
 *
 * A tokenização é o oposto: ela **tem** que acontecer no navegador, porque é assim que o cartão
 * chega ao serviço de tokenização sem passar pelo seu backend. É por isso que o fluxo é partido em
 * dois — e é exatamente o desenho que a integração real usa.
 */

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT ?? 5180);

/** As credenciais vivem só aqui, em memória do processo, e morrem quando ele encerra. */
const credentials = {
  baseUrl: process.env.URL_BASE ?? '',
  clientId: process.env.APP_CLIENT ?? '',
  clientSecret: process.env.CLIENT_SECRET ?? '',
  targetAccountId: process.env.TARGET_ACCOUNT_ID ?? '',
};

let cachedToken = null;

/**
 * Eventos de webhook recebidos, os mais recentes primeiro, com teto fixo.
 *
 * Vivem em memória e morrem com o processo, como as credenciais: a bancada não persiste nada. O
 * teto existe porque este endpoint fica **exposto na internet** quando você abre um túnel — qualquer
 * um com a URL consegue postar nele. Guardar sem limite transformaria isso numa forma trivial de
 * derrubar o processo.
 */
const webhookEvents = [];
const WEBHOOK_EVENTS_MAX = 50;
const WEBHOOK_BODY_MAX_BYTES = 256 * 1024;
let webhookSeq = 0;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Nunca devolve o segredo — só se ele está preenchido. */
function credentialsStatus() {
  return {
    baseUrl: credentials.baseUrl,
    clientId: credentials.clientId,
    targetAccountId: credentials.targetAccountId,
    hasSecret: Boolean(credentials.clientSecret),
    tokenCachedUntil: cachedToken?.expiresAt ?? null,
  };
}

function requireCredentials() {
  const missing = [];
  if (!credentials.baseUrl) missing.push('URL_BASE');
  if (!credentials.clientId) missing.push('APP_CLIENT');
  if (!credentials.clientSecret) missing.push('CLIENT_SECRET');
  if (missing.length) {
    throw Object.assign(new Error(`Credenciais ausentes: ${missing.join(', ')}`), { status: 400 });
  }
}

/**
 * OAuth 2.0 client credentials, como o portal documenta. O token é reaproveitado até 30 segundos
 * antes de expirar — uma bateria de cenários não precisa de um token por requisição.
 */
async function getAccessToken({ force = false } = {}) {
  requireCredentials();

  if (!force && cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
  });

  const response = await fetch(`${credentials.baseUrl.replace(/\/$/, '')}/auth/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`Falha na autenticação (${response.status}): ${text.slice(0, 400)}`), {
      status: response.status,
    });
  }

  const parsed = JSON.parse(text);
  cachedToken = {
    accessToken: parsed.access_token,
    expiresAt: Date.now() + Number(parsed.expires_in ?? 300) * 1000,
  };

  return cachedToken.accessToken;
}

/** Repassa uma chamada autenticada para a API, devolvendo status, corpo e latência. */
async function proxyApi({ method, path, body }) {
  const accessToken = await getAccessToken();
  const url = `${credentials.baseUrl.replace(/\/$/, '')}${path}`;

  const headers = {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/json',
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (credentials.targetAccountId) headers['x-target-account-id'] = credentials.targetAccountId;

  const startedAt = Date.now();
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const latencyMs = Date.now() - startedAt;

  const text = await response.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // resposta não-JSON: devolve como texto para a bancada mostrar o que veio
  }

  return { status: response.status, ok: response.ok, latencyMs, body: parsed, url, method };
}

/**
 * Recebe o webhook do cliente e devolve `200` imediatamente.
 *
 * Responder rápido é parte do contrato: a plataforma trata timeout e não-2xx como falha de entrega
 * e reenvia. Por isso nada aqui valida payload, consulta a API ou escreve em disco — só registra e
 * responde. O que a bancada faz com o evento acontece depois, na página.
 */
async function receiveWebhook(req, res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > WEBHOOK_BODY_MAX_BYTES) {
      res.writeHead(413).end();
      return;
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  let body = raw;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    // corpo não-JSON: fica como texto, para a bancada mostrar exatamente o que chegou
  }

  webhookEvents.unshift({
    id: ++webhookSeq,
    receivedAt: new Date().toISOString(),
    method: req.method,
    path: req.url,
    // Só os cabeçalhos que ajudam a depurar entrega. `authorization` fica de fora de propósito:
    // se você assinar o webhook, o segredo não deve aparecer na tela nem no log da bancada.
    headers: {
      'content-type': req.headers['content-type'] ?? null,
      'user-agent': req.headers['user-agent'] ?? null,
      'x-correlation-id': req.headers['x-correlation-id'] ?? null,
    },
    body,
  });
  if (webhookEvents.length > WEBHOOK_EVENTS_MAX) webhookEvents.length = WEBHOOK_EVENTS_MAX;

  sendJson(res, 200, { received: true });
}

/**
 * Descobre a URL pública do túnel perguntando ao ngrok, que expõe uma API local em `4040`.
 *
 * Evita o passo mais fácil de errar: copiar a URL do terminal do ngrok à mão, colar com um path a
 * mais e passar meia hora achando que o webhook não está sendo entregue. Sem ngrok rodando, a
 * página cai no campo manual — qualquer túnel serve, a bancada só precisa da URL.
 */
async function detectTunnelUrl() {
  try {
    const response = await fetch('http://127.0.0.1:4040/api/tunnels', {
      signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) return null;

    const parsed = await response.json();
    const tunnel = parsed.tunnels?.find((item) => item.public_url?.startsWith('https://')) ?? parsed.tunnels?.[0];
    return tunnel?.public_url ?? null;
  } catch {
    // ngrok não está rodando, ou expõe a API noutra porta: o campo manual resolve
    return null;
  }
}

async function serveStatic(req, res) {
  const requested = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = join(PUBLIC_DIR, normalize(requested).replace(/^(\.\.[/\\])+/, ''));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    await stat(filePath);
  } catch {
    res.writeHead(404).end('Not found');
    return;
  }

  res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
  createReadStream(filePath).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    // O SDK é servido do node_modules: o pacote não está em CDN pública confiável, e assim a
    // bancada funciona offline e na versão exata que o package.json fixa.
    if (req.url === '/vendor/card-tokenization.js') {
      const sdk = await readFile(join(ROOT, 'node_modules/@be.izi/card-tokenization/dist/index.js'));
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(sdk);
      return;
    }

    if (req.url === '/api/credentials' && req.method === 'GET') {
      sendJson(res, 200, credentialsStatus());
      return;
    }

    if (req.url === '/api/credentials' && req.method === 'POST') {
      const incoming = await readJsonBody(req);
      if (typeof incoming.baseUrl === 'string') credentials.baseUrl = incoming.baseUrl.trim();
      if (typeof incoming.clientId === 'string') credentials.clientId = incoming.clientId.trim();
      if (typeof incoming.clientSecret === 'string' && incoming.clientSecret) {
        credentials.clientSecret = incoming.clientSecret.trim();
      }
      if (typeof incoming.targetAccountId === 'string') credentials.targetAccountId = incoming.targetAccountId.trim();
      cachedToken = null;
      sendJson(res, 200, credentialsStatus());
      return;
    }

    if (req.url === '/api/auth/test' && req.method === 'POST') {
      await getAccessToken({ force: true });
      sendJson(res, 200, { ok: true, ...credentialsStatus() });
      return;
    }

    if (req.url === '/api/call' && req.method === 'POST') {
      const { method, path, body } = await readJsonBody(req);
      if (typeof path !== 'string' || !path.startsWith('/')) {
        sendJson(res, 400, { message: 'path inválido' });
        return;
      }
      sendJson(res, 200, await proxyApi({ method: method ?? 'POST', path, body }));
      return;
    }

    // Qualquer caminho sob `/webhook` serve, para você registrar a URL com o sufixo que quiser.
    if (req.url?.startsWith('/webhook') && req.method === 'POST') {
      await receiveWebhook(req, res);
      return;
    }

    if (req.url?.startsWith('/api/webhooks') && req.method === 'GET') {
      const after = Number(new URL(req.url, 'http://localhost').searchParams.get('after') ?? 0);
      const events = webhookEvents.filter((event) => event.id > after);
      sendJson(res, 200, { events, lastId: webhookEvents[0]?.id ?? after, path: '/webhook' });
      return;
    }

    if (req.url === '/api/webhooks' && req.method === 'DELETE') {
      webhookEvents.length = 0;
      sendJson(res, 200, { cleared: true });
      return;
    }

    if (req.url === '/api/tunnel' && req.method === 'GET') {
      sendJson(res, 200, { tunnelUrl: await detectTunnelUrl() });
      return;
    }

    if (req.url?.startsWith('/api/')) {
      sendJson(res, 404, { message: 'rota desconhecida' });
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, error.status ?? 500, { message: error.message ?? 'erro inesperado' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  // Abra por `localhost`, não por `127.0.0.1`: a validação de origem da API só
  // libera `http:` quando o hostname e exatamente `localhost`. Com o IP, o SDK devolve
  // ORIGIN_NOT_ALLOWED mesmo com a origem cadastrada.
  console.log(`\n  Bancada de testes de cartão — http://localhost:${PORT}\n`);
  if (!credentials.clientSecret) {
    console.log('  Configure as credenciais na própria página, ou exporte URL_BASE, APP_CLIENT e CLIENT_SECRET.\n');
  }
});
