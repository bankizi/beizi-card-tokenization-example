import { Beizi, TokenizationError } from '/vendor/card-tokenization.js';
import { AUTHORIZATION, DECLINE, RECEIVABLES, buildAmount, formatBRL } from '/scenarios.js';

const $ = (id) => document.getElementById(id);

const state = {
  authorization: AUTHORIZATION.find((scenario) => scenario.digit === '1'),
  cents: '00',
  runs: [],
};

/** A chave de tokenização fica só na memória da página — nunca vai para o servidor local. */
let tokenizationKey = '';

// ─── Credenciais ──────────────────────────────────────────────────────────────

async function loadCredentials() {
  const status = await fetch('/api/credentials').then((response) => response.json());
  $('baseUrl').value = status.baseUrl ?? '';
  $('clientId').value = status.clientId ?? '';
  $('targetAccountId').value = status.targetAccountId ?? '';
  if (status.hasSecret) $('clientSecret').placeholder = '•••••• (já configurado)';
  paintAuthBadge(status.hasSecret ? 'pronto para autenticar' : 'sem credenciais', status.hasSecret ? '' : 'off');
}

function paintAuthBadge(text, kind) {
  const badge = $('auth-badge');
  badge.textContent = text;
  badge.className = `badge ${kind === 'off' ? 'badge-off' : kind === 'err' ? 'badge-err' : 'badge-ok'}`;
}

$('btn-save-credentials').addEventListener('click', async () => {
  tokenizationKey = $('tokenizationKey').value.trim();

  const response = await fetch('/api/credentials', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseUrl: $('baseUrl').value,
      clientId: $('clientId').value,
      clientSecret: $('clientSecret').value,
      targetAccountId: $('targetAccountId').value,
    }),
  });

  const status = await response.json();
  $('clientSecret').value = '';
  if (status.hasSecret) $('clientSecret').placeholder = '•••••• (já configurado)';

  const feedback = $('credentials-feedback');
  feedback.textContent = 'Salvo. O segredo ficou no processo local.';
  feedback.className = 'feedback ok';
  paintAuthBadge('pronto para autenticar', '');
});

$('btn-test-auth').addEventListener('click', async () => {
  paintAuthBadge('autenticando…', '');
  try {
    const response = await fetch('/api/auth/test', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message);
    paintAuthBadge('autenticado', 'ok');
  } catch (error) {
    paintAuthBadge(error.message.slice(0, 60), 'err');
  }
});

// ─── Cenários ─────────────────────────────────────────────────────────────────

function renderAuthorization() {
  const grid = $('authorization-grid');
  grid.replaceChildren();

  for (const scenario of AUTHORIZATION) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'scenario';
    button.setAttribute('aria-pressed', String(scenario.digit === state.authorization.digit));

    const label = document.createElement('span');
    label.className = 'scenario-label';
    label.textContent = scenario.label;

    const number = document.createElement('span');
    number.className = 'scenario-number';
    number.textContent = scenario.number.replace(/(\d{4})(?=\d)/g, '$1 ');

    const detail = document.createElement('span');
    detail.className = 'scenario-detail';
    detail.textContent = scenario.detail;

    button.append(label, number, detail);

    if (scenario.outcome === 'assincrono') {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'desfecho assíncrono';
      button.append(tag);
    }

    button.addEventListener('click', () => {
      state.authorization = scenario;
      // Nos dois sentidos: escolher a pré-autorização desliga o capture, e sair dela liga de volta.
      // Antes só desligava, então o capture=false ficava grudado no cenário seguinte em silêncio.
      $('capture').value = scenario.suggestsCapture === false ? 'false' : 'true';
      const list = scenario.usesDeclineCents ? DECLINE : RECEIVABLES;
      if (!list.some((item) => item.cents === state.cents)) state.cents = list[0].cents;
      render();
    });

    grid.append(button);
  }
}

function renderDetail() {
  const declines = state.authorization.usesDeclineCents;
  $('detail-title').textContent = declines
    ? 'Motivo da recusa — pelos centavos'
    : 'Recebíveis — pelos centavos';

  const grid = $('detail-grid');
  grid.replaceChildren();

  for (const item of declines ? DECLINE : RECEIVABLES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `chip${item.highlight ? ' is-highlight' : ''}`;
    button.setAttribute('aria-pressed', String(item.cents === state.cents));
    button.title = item.note ?? '';

    const code = document.createElement('code');
    code.textContent = `,${item.cents}`;
    const text = document.createElement('span');
    text.textContent = item.label;

    button.append(code, text);
    button.addEventListener('click', () => {
      state.cents = item.cents;
      render();
    });

    grid.append(button);
  }
}

function currentAmount() {
  return buildAmount($('majorUnits').value || 0, state.cents);
}

function renderAmount() {
  const amount = currentAmount();
  $('amount-preview').textContent = formatBRL(amount);
  $('amount-cents').textContent = `amount: ${amount}`;
  renderPrediction();
}

/**
 * Diz de antemão o que a resposta vai trazer.
 *
 * Existe porque o par cartão × capture engana: um cartão que aprova, enviado com `capture: false`,
 * devolve PRE_AUTHORIZED — está certo, mas surpreende quem escolheu o cartão pelo desfecho.
 */
function renderPrediction() {
  const scenario = state.authorization;
  const captures = $('capture').value === 'true';
  const target = $('prediction');
  if (!target) return;

  let expected;
  if (scenario.outcome === 'erro') {
    expected = 'a criação falha com erro do provedor';
  } else if (!captures && scenario.label.startsWith('Aprovada')) {
    expected = 'PRE_AUTHORIZED — o capture está desligado, então não captura; use a ação Capturar depois';
  } else if (scenario.label.startsWith('Aprovada')) {
    expected = 'CAPTURED, com cronograma de recebíveis';
  } else if (scenario.usesDeclineCents) {
    const reason = DECLINE.find((item) => item.cents === state.cents);
    expected = `DECLINED — ${reason ? reason.label.toLowerCase() : 'motivo pelos centavos'}`;
  } else {
    expected = scenario.label.toLowerCase();
  }

  if (scenario.outcome === 'assincrono') expected += ' · o desfecho final chega alguns segundos depois';

  target.textContent = `Resposta esperada: ${expected}.`;
}

function render() {
  renderAuthorization();
  renderDetail();
  renderAmount();
}

for (const id of ['majorUnits', 'installments']) {
  $(id).addEventListener('input', renderAmount);
}

$('capture').addEventListener('change', renderPrediction);

// ─── Execução ─────────────────────────────────────────────────────────────────

function buildOrderId() {
  return `TESTE-${state.authorization.digit}${state.cents}-${Date.now().toString(36).toUpperCase()}`;
}

async function tokenize() {
  if (!tokenizationKey) {
    throw new Error('Informe a chave de tokenização e salve as credenciais.');
  }

  const beizi = Beizi.create({ tokenizationKey, environment: 'HOM' });

  return beizi.tokenize({
    number: state.authorization.number,
    holder: 'MARIA DA SILVA',
    expiryMonth: '12',
    expiryYear: '2030',
    cvv: '123',
  });
}

async function callApi(path, body, method = 'POST') {
  const response = await fetch('/api/call', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, path, body }),
  });

  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? 'falha no proxy local');
  return result;
}

async function runScenario({ tokenizeOnly = false } = {}) {
  const scenario = state.authorization;
  const amount = currentAmount();
  const run = {
    id: crypto.randomUUID(),
    startedAt: new Date(),
    title: `${scenario.label} · ${formatBRL(amount)}`,
    subtitle: `cartão …${scenario.number.slice(-4)} · centavos ,${state.cents}`,
    steps: [],
    status: 'ok',
    transactionId: null,
  };

  state.runs.unshift(run);
  renderHistory();

  // Passo 1 — tokenização, no navegador. O cartão nunca passa pelo proxy.
  try {
    const token = await tokenize();
    run.steps.push({
      name: 'Tokenização (navegador)',
      meta: token.brand,
      payload: { ...token, cardToken: `${token.cardToken.slice(0, 24)}… (${token.cardToken.length} chars)` },
    });
    run.token = token;
  } catch (error) {
    run.status = 'err';
    run.steps.push({
      name: 'Tokenização (navegador)',
      meta: 'falhou',
      payload:
        error instanceof TokenizationError
          ? { code: error.code, field: error.field, retryable: error.retryable, message: error.message }
          : { message: error.message },
    });
    renderHistory();
    return run;
  }

  if (tokenizeOnly) {
    renderHistory();
    return run;
  }

  // Passo 2 — transação, pelo proxy local, que é quem tem o segredo.
  const body = {
    amount,
    installments: Number($('installments').value),
    capture: $('capture').value === 'true',
    orderId: buildOrderId(),
    cardToken: run.token.cardToken,
    customerInfo: { name: 'Maria da Silva', document: '52998224725' },
  };

  run.requestBody = body;

  try {
    const result = await callApi($('createPath').value.trim(), body);
    run.status = result.ok ? 'ok' : 'warn';
    run.transactionId = result.body?.transactionId ?? null;
    run.steps.push({
      name: `Transação · HTTP ${result.status}`,
      meta: `${result.latencyMs} ms`,
      payload: { request: { ...body, cardToken: '«token»' }, response: result.body },
    });
  } catch (error) {
    run.status = 'err';
    run.steps.push({ name: 'Transação', meta: 'falhou', payload: { message: error.message } });
  }

  renderHistory();
  return run;
}

$('btn-run').addEventListener('click', () => runScenario());
$('btn-tokenize-only').addEventListener('click', () => runScenario({ tokenizeOnly: true }));

/** Varredura: roda os nove cenários de recebível em sequência, com o cartão que aprova. */
$('btn-run-sweep').addEventListener('click', async () => {
  const button = $('btn-run-sweep');
  button.disabled = true;

  const previousScenario = state.authorization;
  const previousCents = state.cents;
  const previousCapture = $('capture').value;
  state.authorization = AUTHORIZATION.find((scenario) => scenario.digit === '1');
  // Sem isto, uma varredura logo depois do cenário de pré-autorização rodaria os nove com
  // `capture: false` — nove PRE_AUTHORIZED e nenhum recebível, sem nada indicando o porquê.
  $('capture').value = 'true';

  try {
    for (const item of RECEIVABLES) {
      state.cents = item.cents;
      render();
      await runScenario();
    }
  } finally {
    state.authorization = previousScenario;
    state.cents = previousCents;
    $('capture').value = previousCapture;
    render();
    button.disabled = false;
  }
});

$('btn-clear').addEventListener('click', () => {
  state.runs = [];
  renderHistory();
});

// ─── Histórico ────────────────────────────────────────────────────────────────

function renderHistory() {
  const container = $('history');
  container.replaceChildren();

  $('history-count').textContent = state.runs.length
    ? `${state.runs.length} execução(ões)`
    : 'nenhuma execução ainda';

  if (!state.runs.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Escolha um cenário e execute. Cada passo aparece aqui com o que foi enviado e recebido.';
    container.append(empty);
    return;
  }

  for (const run of state.runs) {
    const details = document.createElement('details');
    details.className = 'run';
    details.open = run === state.runs[0];

    const summary = document.createElement('summary');
    const dot = document.createElement('span');
    dot.className = `run-status ${run.status}`;
    const title = document.createElement('span');
    title.className = 'run-title';
    title.textContent = run.title;
    const meta = document.createElement('span');
    meta.className = 'run-meta';
    meta.textContent = `${run.subtitle} · ${run.startedAt.toLocaleTimeString('pt-BR')}`;
    summary.append(dot, title, meta);

    const body = document.createElement('div');
    body.className = 'run-body';

    for (const step of run.steps) {
      const step$ = document.createElement('div');
      step$.className = 'step';

      const head = document.createElement('div');
      head.className = 'step-head';
      const name = document.createElement('span');
      name.textContent = step.name;
      const metaSpan = document.createElement('span');
      metaSpan.className = 'muted';
      metaSpan.textContent = step.meta ?? '';
      head.append(name, metaSpan);

      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify(step.payload, null, 2);

      step$.append(head, pre);
      body.append(step$);
    }

    if (run.transactionId) {
      const actions = document.createElement('div');
      actions.className = 'actions';

      // A pré-autorização só fecha o ciclo com uma captura. Sem isto, o cartão `…0002` era um beco
      // sem saída: a bancada criava a transação e não tinha como levá-la adiante.
      for (const action of ['capture', 'cancel']) {
        const button$ = document.createElement('button');
        button$.className = 'btn';
        button$.type = 'button';
        button$.textContent = action === 'capture' ? 'Capturar' : 'Cancelar';
        button$.addEventListener('click', async () => {
          button$.disabled = true;
          const path = $('createPath').value.trim().replace(/\/create$/, `/${action}`);
          try {
            const result = await callApi(path, { identifier: run.transactionId });
            run.steps.push({
              name: `${action === 'capture' ? 'Captura' : 'Cancelamento'} · HTTP ${result.status}`,
              meta: `${result.latencyMs} ms`,
              payload: { request: { identifier: run.transactionId }, response: result.body },
            });
          } catch (error) {
            run.steps.push({ name: action === 'capture' ? 'Captura' : 'Cancelamento', meta: 'falhou', payload: { message: error.message } });
          }
          renderHistory();
        });
        actions.append(button$);
      }

      const poll = document.createElement('button');
      poll.className = 'btn';
      poll.type = 'button';
      poll.textContent = 'Consultar status';
      poll.addEventListener('click', async () => {
        const path = `${$('createPath').value.replace(/\/create$/, '')}/${run.transactionId}`;
        const result = await callApi(path, undefined, 'GET');
        run.steps.push({
          name: `Consulta · HTTP ${result.status}`,
          meta: `${result.latencyMs} ms`,
          payload: result.body,
        });
        renderHistory();
      });

      const curl = document.createElement('button');
      curl.className = 'btn btn-ghost';
      curl.type = 'button';
      curl.textContent = 'Copiar body';
      curl.addEventListener('click', () => {
        navigator.clipboard.writeText(JSON.stringify(run.requestBody, null, 2));
        curl.textContent = 'copiado';
        setTimeout(() => (curl.textContent = 'Copiar body'), 1500);
      });

      actions.append(poll, curl);
      body.append(actions);
    }

    details.append(summary, body);
    container.append(details);
  }
}

// ─── Início ───────────────────────────────────────────────────────────────────

render();
renderHistory();
loadCredentials();
