import { Beizi, TokenizationError } from '/vendor/card-tokenization.js';
import {
  AUTHORIZATION,
  CREATE_FAILURE,
  DECLINE,
  OPERATION_FAILURE,
  RECEIVABLES,
  buildAmount,
  formatBRL,
} from '/scenarios.js';

const $ = (id) => document.getElementById(id);

const state = {
  authorization: AUTHORIZATION.find((scenario) => scenario.digit === '1'),
  cents: '00',
  runs: [],
  /** Eventos de webhook recebidos, mais recentes primeiro, e o cursor do último já lido. */
  webhooks: [],
  webhookCursor: 0,
};

/** A chave de tokenização fica só na memória da página — nunca vai para o servidor local. */
let tokenizationKey = '';

// ─── Desfecho ─────────────────────────────────────────────────────────────────

/**
 * O que fazer com cada desfecho — e por que esta tabela existe.
 *
 * No cartão o status HTTP descreve a **chamada**, não o pagamento: os cinco desfechos respondem
 * `201`, com a transação em `data` — recusa, falha e desfecho indeterminado inclusive. Decidir por
 * `response.ok` colapsa os três numa coisa só, que é exatamente o que o contrato de `outcome`
 * existe para separar. A bancada lê sempre `data.outcome`.
 */
const OUTCOMES = {
  APPROVED: { dot: 'ok', badge: 'badge-ok', hint: 'capturada — o dinheiro se moveu' },
  PENDING: { dot: 'warn', badge: 'badge-warn', hint: 'existe no provedor e ainda vai mudar; aguarde o webhook ou consulte' },
  REFUSED: { dot: 'warn', badge: 'badge-err', hint: 'recusa terminal e conhecida; outro cartão pode passar' },
  FAILED: { dot: 'err', badge: 'badge-err', hint: 'não virou transação; nada foi cobrado' },
  UNKNOWN: { dot: 'err', badge: 'badge-err', hint: 'desfecho indeterminado — não repita; reconcilie por consulta' },
};

/**
 * Normaliza qualquer resposta da API para a mesma forma, vindo ela do envelope de sucesso
 * (`{success, code, data}`) ou do de erro (`{success, code, message}`).
 */
function readOutcome(result) {
  const envelope = result.body && typeof result.body === 'object' ? result.body : {};
  const data = envelope.data ?? null;

  if (data?.outcome) {
    return { outcome: data.outcome, data, reason: data.reason ?? null };
  }

  // Envelope de erro: a requisição foi reprovada **antes** de existir transação — payload
  // inválido, `orderId` repetido, token já consumido. Não há desfecho de pagamento para mostrar, e
  // a bancada não inventa um: mostra a mensagem e deixa o `outcome` vazio de propósito.
  if (envelope.success === false) {
    return {
      outcome: null,
      data,
      reason: {
        code: null,
        category: null,
        message: envelope.message ?? null,
        retryable: null,
        invalidFields: envelope.details?.invalidFields ?? null,
      },
    };
  }

  // Resposta que este contrato não cobre. Cai no status HTTP, que é o melhor que se pode dizer, e
  // nunca é lido como aprovação.
  return { outcome: null, data, reason: null };
}

/** Os identificadores que a reconciliação usa. Existem na recusa e na falha, não só na aprovação. */
function readIdentifiers(data) {
  if (!data) return {};
  const { transactionId, orderId, integrationId, externalId, tid } = data;
  return { transactionId, orderId, integrationId, externalId, tid };
}

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
    // O texto cru do upstream não vira rótulo de UI: ele pode carregar qualquer coisa que o
    // provedor de identidade resolva devolver. O detalhe fica no console, o rótulo fica estável.
    console.error('[bancada] falha ao autenticar:', error);
    paintAuthBadge('falha ao autenticar — veja o console', 'err');
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
      const list = detailList(scenario);
      if (!list.some((item) => item.cents === state.cents)) state.cents = list[0].cents;
      render();
    });

    grid.append(button);
  }
}

/**
 * Que centavos escolher, dado o cartão.
 *
 * Eram duas listas, e o cartão de falha caía na de recebíveis — os centavos `10`, `20`, `30` e `40`
 * não existem lá, então quatro dos cinco tipos de falha, incluindo o desfecho indeterminado, não
 * podiam ser produzidos pela bancada. As falhas de operação viajam junto com os recebíveis porque
 * são escolhidas pelo valor da **criação** e só se manifestam na captura.
 */
function detailList(scenario) {
  if (scenario.usesDeclineCents) return DECLINE;
  if (scenario.usesFailureCents) return CREATE_FAILURE;
  return [...RECEIVABLES, ...OPERATION_FAILURE];
}

function detailTitle(scenario) {
  if (scenario.usesDeclineCents) return 'Motivo da recusa — pelos centavos';
  if (scenario.usesFailureCents) return 'Tipo da falha — pelos centavos';
  return 'Recebíveis e falhas de operação — pelos centavos';
}

function renderDetail() {
  const scenario = state.authorization;
  $('detail-title').textContent = detailTitle(scenario);

  const grid = $('detail-grid');
  grid.replaceChildren();

  for (const item of detailList(scenario)) {
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

    // O desfecho esperado na própria etiqueta: `20` e `71` levam a UNKNOWN, e isso muda o que a
    // integração pode fazer depois. Ver na hora de escolher evita escolher sem saber.
    if (item.outcome) {
      const tag = document.createElement('span');
      tag.className = 'chip-tag';
      tag.textContent = item.operation ? `${item.outcome} na captura` : item.outcome;
      button.append(tag);
    }

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

  // Prevê os dois campos, e não só o status. `outcome` e `status` respondem perguntas diferentes —
  // uma pré-autorização é `PENDING` com `status: PRE_AUTHORIZED`, e uma recusa por fraude é
  // `REFUSED` com `status: CANCELED`. Prever só um dos dois ensina a ler o campo errado.
  let expected;
  if (scenario.usesFailureCents) {
    const failure = CREATE_FAILURE.find((item) => item.cents === state.cents);
    expected = failure
      ? `outcome: ${failure.outcome} — ${failure.label.toLowerCase()}, em 201 com o motivo em data.reason`
      : 'a criação falha, em 201 com o motivo em data.reason';
  } else if (!captures && scenario.label.startsWith('Aprovada')) {
    expected = 'outcome: PENDING · status: PRE_AUTHORIZED — o capture está desligado; use a ação Capturar depois';
  } else if (scenario.label.startsWith('Aprovada')) {
    expected = 'outcome: APPROVED · status: CAPTURED, com cronograma de recebíveis';
  } else if (scenario.usesDeclineCents) {
    const reason = DECLINE.find((item) => item.cents === state.cents);
    const status = reason?.cents === '90' || reason?.cents === '91' ? 'CANCELED' : 'DECLINED';
    expected = `outcome: REFUSED · status: ${status} — ${reason ? reason.label.toLowerCase() : 'motivo pelos centavos'}`;
  } else {
    expected = scenario.label.toLowerCase();
  }

  if (scenario.outcome === 'assincrono') expected += ' · o desfecho final chega alguns segundos depois';

  // A falha de operação não muda a criação: ela só aparece quando a captura roda.
  const operation = OPERATION_FAILURE.find((item) => item.cents === state.cents);
  if (operation && !scenario.usesDeclineCents && !scenario.usesFailureCents) {
    expected += ` · a captura depois volta ${operation.outcome}`;
  }

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
    outcome: null,
    reason: null,
    identifiers: {},
    /** Identificador aceito pela captura e pela consulta. */
    identifier: null,
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
    applyOutcome(run, result, { name: 'Transação', request: { ...body, cardToken: '«token»' } });
  } catch (error) {
    run.status = 'err';
    run.steps.push({ name: 'Transação', meta: 'falhou', payload: { message: error.message } });
  }

  renderHistory();
  return run;
}

/**
 * Traduz uma resposta da API em estado da execução. É o único lugar que faz isso, de propósito: a
 * criação, a captura e a consulta seguem o mesmo contrato de desfecho, e ter três leituras
 * diferentes foi o que fazia a captura não registrar desfecho nenhum.
 */
function applyOutcome(run, result, { name, request }) {
  const { outcome, data, reason } = readOutcome(result);
  const identifiers = readIdentifiers(data);

  run.outcome = outcome;
  run.reason = reason;
  // Os identificadores são acumulados: uma consulta posterior pode trazer o que a criação não
  // tinha, e nenhum desfecho deve apagar o que já se sabia.
  run.identifiers = { ...run.identifiers, ...Object.fromEntries(Object.entries(identifiers).filter(([, v]) => v)) };
  run.identifier =
    run.identifiers.integrationId ?? run.identifiers.transactionId ?? run.identifiers.externalId ?? run.identifier;

  // Sem `outcome` reconhecido cai no status HTTP — e um 2xx desconhecido é `warn`, nunca `ok`.
  run.status = outcome ? OUTCOMES[outcome].dot : result.ok ? 'warn' : 'err';

  run.steps.push({
    name: `${name} · HTTP ${result.status}`,
    meta: `${result.latencyMs} ms`,
    outcome,
    reason,
    identifiers: run.identifiers,
    payload: request ? { request, response: result.body } : result.body,
  });
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

/**
 * O motivo, como a integração deve lê-lo.
 *
 * Existe porque a bancada só despejava o corpo num `<pre>`, e ali `reason.message` e
 * `acquirerInfo.message` têm o mesmo peso visual — no cenário `,90` o adquirente responde
 * `00 / SUCESSO` numa transação recusada, então o dump ensinava a ler o campo errado. Aqui a
 * separação é explícita: `message` é o texto do pagador, `code` é a chave de lógica, e o
 * diagnóstico do provedor fica fechado e rotulado como o que é.
 */
function renderReason(step) {
  const block = document.createElement('div');
  block.className = 'reason';

  const head = document.createElement('div');
  head.className = 'reason-head';

  const badge = document.createElement('span');
  const semantics = step.outcome ? OUTCOMES[step.outcome] : null;
  badge.className = `badge ${semantics ? semantics.badge : 'badge-off'}`;
  badge.textContent = step.outcome ?? 'sem outcome';
  head.append(badge);

  if (semantics) {
    const hint = document.createElement('span');
    hint.className = 'reason-hint';
    hint.textContent = semantics.hint;
    head.append(hint);
  }

  block.append(head);

  const reason = step.reason;
  if (reason) {
    if (reason.message) {
      const message = document.createElement('p');
      message.className = 'reason-message';
      message.textContent = reason.message;
      block.append(message);

      const caption = document.createElement('p');
      caption.className = 'reason-caption';
      caption.textContent = 'reason.message — este é o texto exibível ao pagador.';
      block.append(caption);
    }

    const meta = document.createElement('dl');
    meta.className = 'reason-meta';
    const entries = [
      ['code', reason.code],
      ['category', reason.category],
      ['retryable', reason.retryable === null || reason.retryable === undefined ? null : String(reason.retryable)],
    ];
    for (const [key, value] of entries) {
      if (!value) continue;
      const dt = document.createElement('dt');
      dt.textContent = key;
      const dd = document.createElement('dd');
      dd.textContent = value;
      meta.append(dt, dd);
    }
    block.append(meta);

    if (reason.retryable === false) {
      const note = document.createElement('p');
      note.className = 'reason-caption';
      note.textContent = 'retryable: false — uma nova tentativa desta cobrança não vai dar certo.';
      block.append(note);
    }

    if (reason.invalidFields?.length) {
      const fields = document.createElement('p');
      fields.className = 'reason-fields';
      fields.textContent = `invalidFields: ${reason.invalidFields.join(', ')}`;
      block.append(fields);
    }

    if (reason.provider) {
      const diagnostics = document.createElement('details');
      diagnostics.className = 'diagnostics';
      const summary = document.createElement('summary');
      summary.textContent = 'reason.provider — diagnóstico; nunca exiba ao pagador';
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify(reason.provider, null, 2);
      diagnostics.append(summary, pre);
      block.append(diagnostics);
    }
  }

  return block;
}

/**
 * Os identificadores, fora do dump.
 *
 * Vão para a tela em **todo** desfecho, e não só na aprovação: `data` e `reason` coexistem no
 * contrato, então uma recusa e a falha do cenário `,30` também trazem o identificador — que é a
 * única chave de reconciliação que existe.
 */
function renderIdentifiers(identifiers) {
  const entries = Object.entries(identifiers).filter(([, value]) => value);
  if (!entries.length) return null;

  const list = document.createElement('dl');
  list.className = 'identifiers';
  for (const [key, value] of entries) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    list.append(dt, dd);
  }
  return list;
}

/** O aviso do desfecho indeterminado. É a única coisa nesta tela que impede uma cobrança dupla. */
function renderUndeterminedWarning() {
  const warning = document.createElement('p');
  warning.className = 'undetermined';
  warning.textContent =
    'Desfecho indeterminado: o pedido saiu e a resposta não voltou, então pode existir cobrança no provedor. Não repita esta cobrança. Use Consultar status para descobrir o desfecho real, ou aguarde o webhook de transação.';
  return warning;
}

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

      step$.append(head);

      // O que a integração lê vem **antes** do dump. O corpo cru continua embaixo, para inspeção,
      // mas deixou de ser a única leitura disponível.
      if (step.outcome || step.reason) step$.append(renderReason(step));
      if (step.outcome === 'UNKNOWN') step$.append(renderUndeterminedWarning());
      const identifiers = step.identifiers ? renderIdentifiers(step.identifiers) : null;
      if (identifiers) step$.append(identifiers);

      step$.append(pre);
      body.append(step$);
    }

    // O identificador saía de `body.transactionId`, mas o proxy devolve o envelope inteiro e ele
    // mora em `body.data`. Era sempre `undefined`, então este bloco nunca renderizava e metade da
    // bancada — captura e consulta — estava inacessível.
    if (run.identifier) {
      const actions = document.createElement('div');
      actions.className = 'actions';
      const undetermined = run.outcome === 'UNKNOWN';

      // A pré-autorização só fecha o ciclo com uma captura. Sem isto, o cartão `…0002` era um beco
      // sem saída: a bancada criava a transação e não tinha como levá-la adiante.
      //
      // Num desfecho indeterminado ela fica desligada: pode haver captura do outro lado, e mandar
      // outra operação antes de saber é a forma mais direta de cobrar o mesmo pagador duas vezes.
      // Sobra a consulta, que é exatamente o que se deve fazer.
      for (const action of ['capture']) {
        const button$ = document.createElement('button');
        button$.className = 'btn';
        button$.type = 'button';
        button$.textContent = 'Capturar';
        button$.disabled = undetermined;
        if (undetermined) button$.title = 'Desfecho indeterminado: consulte antes de qualquer operação.';
        button$.addEventListener('click', async () => {
          button$.disabled = true;
          const path = $('createPath').value.trim().replace(/\/create$/, `/${action}`);
          const name = 'Captura';
          try {
            const result = await callApi(path, { identifier: run.identifier });
            applyOutcome(run, result, { name, request: { identifier: run.identifier } });
          } catch (error) {
            run.status = 'err';
            run.steps.push({ name, meta: 'falhou', payload: { message: error.message } });
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
        const path = `${$('createPath').value.replace(/\/create$/, '')}/${run.identifier}`;
        // A consulta não tinha `try/catch`: uma falha rejeitava sem tratamento e o botão não fazia
        // nada visível — justamente no caminho que o desfecho indeterminado obriga a usar.
        try {
          const result = await callApi(path, undefined, 'GET');
          applyOutcome(run, result, { name: 'Consulta' });
        } catch (error) {
          run.status = 'err';
          run.steps.push({ name: 'Consulta', meta: 'falhou', payload: { message: error.message } });
        }
        renderHistory();
      });

      const curl = document.createElement('button');
      curl.className = 'btn btn-ghost';
      curl.type = 'button';
      curl.textContent = 'Copiar body';
      curl.disabled = undetermined;
      if (undetermined) curl.title = 'Desfecho indeterminado: não reenvie esta cobrança.';
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

// ─── Webhook ──────────────────────────────────────────────────────────────────

/**
 * A URL que você cadastra como destino do webhook de transação.
 *
 * O caminho é sempre `/webhook`; o que muda é o endereço público na frente dele. Montar isso aqui,
 * em vez de deixar a pessoa concatenar à mão, elimina o erro mais chato de depurar: uma barra a
 * mais, o path esquecido, e a entrega falha em silêncio do outro lado.
 */
function renderWebhookUrl() {
  const base = $('tunnelUrl').value.trim().replace(/\/+$/, '');
  $('webhook-url').textContent = base ? `${base}/webhook` : '— informe o endereço do túnel acima';
}

/**
 * Casa o evento com a execução que o originou.
 *
 * Pelo `transactionId` e pelo `orderId`, que são os dois identificadores que o evento carrega e a
 * bancada conhece. Sem isso o webhook seria uma lista solta ao lado do histórico, e a pergunta que
 * importa — "este evento é da transação que acabei de criar?" — ficaria por conta do olho.
 */
function matchRun(event) {
  const body = event.body && typeof event.body === 'object' ? event.body : {};
  if (!body.transactionId && !body.orderId) return null;

  return (
    state.runs.find(
      (run) =>
        (body.transactionId && run.identifiers?.transactionId === body.transactionId) ||
        (body.orderId && run.identifiers?.orderId === body.orderId),
    ) ?? null
  );
}

function renderWebhookEvents() {
  const container = $('webhook-events');
  container.textContent = '';

  $('webhook-count').textContent = state.webhooks.length
    ? `${state.webhooks.length} evento${state.webhooks.length > 1 ? 's' : ''} recebido${state.webhooks.length > 1 ? 's' : ''}`
    : 'nenhum evento recebido';

  for (const event of state.webhooks) {
    const body = event.body && typeof event.body === 'object' ? event.body : {};
    const item = document.createElement('details');
    item.className = 'webhook-event';

    const summary = document.createElement('summary');
    const dot = document.createElement('span');
    // O ponto segue o desfecho quando o evento traz um: um webhook de recusa não deve parecer
    // sucesso só porque a entrega funcionou.
    dot.className = `dot ${body.outcome ? OUTCOMES[body.outcome]?.dot ?? 'warn' : 'warn'}`;
    summary.append(dot);

    const title = document.createElement('strong');
    title.textContent = body.status ? `${body.previousStatus ?? '—'} → ${body.status}` : event.path;
    summary.append(title);

    if (body.outcome) {
      const tag = document.createElement('span');
      tag.className = `badge ${OUTCOMES[body.outcome]?.badge ?? 'badge-warn'}`;
      tag.textContent = body.outcome;
      summary.append(tag);
    }

    const meta = document.createElement('span');
    meta.className = 'hint';
    const run = matchRun(event);
    meta.textContent = [
      new Date(event.receivedAt).toLocaleTimeString('pt-BR'),
      body.transactionId ?? null,
      run ? 'casa com uma execução do histórico' : null,
    ]
      .filter(Boolean)
      .join(' · ');
    summary.append(meta);

    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(event.body, null, 2);

    item.append(summary, pre);
    container.append(item);
  }
}

/**
 * Busca os eventos novos por cursor, e não a lista inteira: assim uma bateria longa não fica
 * redesenhando dezenas de eventos a cada dois segundos.
 *
 * Um evento que casa com uma execução entra também no histórico dela, como mais um passo — é o que
 * torna visível a sequência "criei, veio `PENDING`, o webhook trouxe `CAPTURED`".
 */
async function pollWebhooks() {
  try {
    const response = await fetch(`/api/webhooks?after=${state.webhookCursor}`);
    if (!response.ok) return;

    const { events, lastId } = await response.json();
    if (!events?.length) return;

    state.webhookCursor = lastId ?? state.webhookCursor;
    state.webhooks = [...events, ...state.webhooks].slice(0, 50);

    let touchedHistory = false;
    for (const event of events) {
      const run = matchRun(event);
      if (!run) continue;

      const body = event.body ?? {};
      run.steps.push({
        name: `Webhook · ${body.status ?? 'evento'}`,
        meta: new Date(event.receivedAt).toLocaleTimeString('pt-BR'),
        outcome: body.outcome ?? null,
        reason: body.reason ?? null,
        payload: body,
      });
      // O webhook é a autoridade sobre o desfecho final: ele chega depois e sabe mais que a
      // resposta síncrona. Um `PENDING` que vira `CAPTURED` precisa aparecer assim no cartão.
      if (body.outcome) {
        run.outcome = body.outcome;
        run.status = OUTCOMES[body.outcome]?.dot ?? run.status;
      }
      touchedHistory = true;
    }

    renderWebhookEvents();
    if (touchedHistory) renderHistory();
  } catch {
    // servidor local reiniciando, ou a página em segundo plano: a próxima rodada resolve
  }
}

async function detectTunnel() {
  const button = $('btn-detect-tunnel');
  button.disabled = true;
  button.textContent = 'detectando…';

  try {
    const response = await fetch('/api/tunnel');
    const { tunnelUrl } = await response.json();
    if (tunnelUrl) {
      $('tunnelUrl').value = tunnelUrl;
      localStorage.setItem('beizi.tunnelUrl', tunnelUrl);
      renderWebhookUrl();
      button.textContent = 'ngrok encontrado';
    } else {
      button.textContent = 'ngrok não respondeu';
    }
  } catch {
    button.textContent = 'ngrok não respondeu';
  }

  setTimeout(() => {
    button.disabled = false;
    button.textContent = 'Detectar ngrok';
  }, 2000);
}

// ─── Consulta avulsa ──────────────────────────────────────────────────────────

/**
 * Consulta uma transação por qualquer identificador, inclusive de outra sessão.
 *
 * O histórico só conhece o que esta aba criou; depois de um `UNKNOWN` de ontem, ou de um teste
 * feito por outra pessoa, a única forma de descobrir o desfecho real é esta. É a mesma rota que o
 * botão "Consultar status" usa por execução.
 */
async function lookupTransaction() {
  const identifier = $('lookupIdentifier').value.trim();
  const container = $('lookup-result');
  container.textContent = '';

  if (!identifier) {
    container.textContent = 'Informe um identificador.';
    return;
  }

  const path = `${$('createPath').value.replace(/\/create$/, '')}/${encodeURIComponent(identifier)}`;
  container.textContent = 'consultando…';

  try {
    const result = await callApi(path, undefined, 'GET');
    const { outcome, data, reason } = readOutcome(result);

    container.textContent = '';

    const head = document.createElement('div');
    head.className = 'row wrap';

    const dot = document.createElement('span');
    dot.className = `dot ${outcome ? OUTCOMES[outcome].dot : result.ok ? 'warn' : 'err'}`;
    head.append(dot);

    const title = document.createElement('strong');
    title.textContent = data?.status ? `status: ${data.status}` : `HTTP ${result.status}`;
    head.append(title);

    if (outcome) {
      const badge = document.createElement('span');
      badge.className = `badge ${OUTCOMES[outcome].badge}`;
      badge.textContent = outcome;
      head.append(badge);

      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = OUTCOMES[outcome].hint;
      head.append(hint);
    }

    if (reason?.code || reason?.message) {
      const why = document.createElement('p');
      why.className = 'hint';
      why.textContent = [reason.code, reason.message].filter(Boolean).join(' — ');
      container.append(head, why);
    } else {
      container.append(head);
    }

    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(result.body, null, 2);
    container.append(pre);
  } catch (error) {
    container.textContent = `falhou: ${error.message}`;
  }
}

// ─── Início ───────────────────────────────────────────────────────────────────

$('tunnelUrl').value = localStorage.getItem('beizi.tunnelUrl') ?? '';
$('tunnelUrl').addEventListener('input', () => {
  localStorage.setItem('beizi.tunnelUrl', $('tunnelUrl').value.trim());
  renderWebhookUrl();
});
$('btn-detect-tunnel').addEventListener('click', detectTunnel);
$('btn-copy-webhook').addEventListener('click', () => {
  const url = $('webhook-url').textContent;
  if (!url.startsWith('http')) return;
  navigator.clipboard.writeText(url);
  $('btn-copy-webhook').textContent = 'copiado';
  setTimeout(() => ($('btn-copy-webhook').textContent = 'Copiar'), 1500);
});
$('btn-clear-webhooks').addEventListener('click', async () => {
  await fetch('/api/webhooks', { method: 'DELETE' });
  state.webhooks = [];
  renderWebhookEvents();
});
$('btn-lookup').addEventListener('click', lookupTransaction);
$('lookupIdentifier').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') lookupTransaction();
});

render();
renderHistory();
renderWebhookUrl();
renderWebhookEvents();
loadCredentials();

// Dois segundos é folgado para uma bancada e barato para o processo local. O webhook do cliente
// leva alguns segundos para chegar; não há o que ganhar apertando isso.
setInterval(pollWebhooks, 2000);
if (!$('tunnelUrl').value) detectTunnel();
