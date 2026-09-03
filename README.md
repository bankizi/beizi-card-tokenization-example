# Bancada de testes de cartão — Be.izi

Exemplo executável do SDK [`@be.izi/card-tokenization`](https://www.npmjs.com/package/@be.izi/card-tokenization).
A bancada roda na sua máquina e reproduz o mesmo desenho da integração real: o cartão é tokenizado
no navegador pelo SDK e a transação é criada a partir do lado servidor.

Com ela dá para percorrer todos os cenários de cartão em homologação — aprovação, pré-autorização,
recusa por motivo, recusa por fraude, análise assíncrona, estorno, contestação, os cinco tipos de
falha na criação e as nove trajetórias de recebíveis — e ver, em cada passo, o desfecho, o motivo, o
corpo enviado, a resposta e a latência.

## Antes de começar, fale com o suporte

Informe ao suporte Be.izi **em qual porta você vai subir a bancada localmente** — o padrão deste
repositório é a `5180`. Precisamos registrar essa origem (`http://localhost:5180`) na sua credencial
de homologação e gerar a chave de tokenização que o SDK usa no navegador. Sem esse registro prévio,
a tokenização é recusada com `ORIGIN_NOT_ALLOWED`.

Você vai receber:

- a URL base da API de homologação;
- o `client_id` e o `client_secret` da sua credencial;
- a chave de tokenização.

## Como rodar

Requer Node.js 24 ou mais novo.

```bash
npm install
npm start          # http://localhost:5180
```

Preencha as credenciais na própria página. Para não digitá-las a cada vez:

```bash
URL_BASE='https://...' APP_CLIENT='...' CLIENT_SECRET='...' npm start
```

Para usar outra porta — combinada com o suporte antes, para que a origem seja registrada:

```bash
PORT=5190 npm start
```

## Por que existe um servidor local

O fluxo é partido em dois de propósito, e é o mesmo desenho da integração real:

- **a tokenização acontece no navegador** — é o que impede o cartão de passar pelo seu backend;
- **a transação sai do processo local**, que é quem guarda o `client_secret`.

Colocar o `client_secret` no navegador exporia o segredo na aba de rede e no bundle, e a chamada
ainda esbarraria em CORS. O servidor resolve as duas coisas: ele faz o `client_credentials`,
reaproveita o token até perto de expirar e repassa a chamada autenticada.

O segredo fica em memória do processo, nunca é devolvido para a página e desaparece quando o
processo encerra. A chave de tokenização é o oposto: fica só no navegador, porque é lá que o SDK
roda.

## Pontos de atenção

- **abra por `http://localhost:5180`, nunca por `127.0.0.1`** — a API só aceita origens `http:`
  quando o hostname é exatamente `localhost`, e o IP devolve `ORIGIN_NOT_ALLOWED`;
- a origem que você vai usar precisa constar em `allowedOrigins` da sua credencial;
- a conta precisa estar habilitada para cartão;
- os cenários de cartão dependem do provedor simulado estar habilitado para a conta de homologação;
- o caminho de criação é configurável na página: o serviço usa versionamento por URI
  (`/v1/card/transactions/create`), mas o gateway pode expor sem o prefixo.

## O que dá para fazer

- escolher o cenário de autorização pelo cartão e o detalhe pelos centavos, sem decorar tabela;
- exercitar os cinco tipos de falha na criação e a falha da captura;
- rodar os nove cenários de recebível em sequência com um clique;
- ver o desfecho, o motivo e os identificadores de cada passo, além do corpo cru e da latência;
- consultar o status depois, para os cenários cujo desfecho é assíncrono;
- **consultar qualquer transação por identificador**, inclusive de outra sessão ou de outra pessoa;
- **receber o webhook de transação** num túnel e ver o evento chegar, ligado à execução que o gerou;
- copiar o body para reproduzir fora da bancada.

## Ver o webhook chegando

A resposta síncrona conta metade da história: a pré-autorização que vira captura, o desfecho
indeterminado que se resolve depois e o estorno chegam pelo **webhook de transação**. Para ver isso
acontecer, a bancada precisa de um endereço público.

1. Suba a bancada (`npm start`) e, noutro terminal, abra um túnel para a mesma porta:

   ```bash
   ngrok http 5180
   ```

2. No painel **Webhook**, clique em *Detectar ngrok*. A bancada pergunta à API local do ngrok
   (`127.0.0.1:4040`) e preenche o endereço sozinha. Sem ngrok, cole a URL de qualquer túnel no
   campo — a bancada só precisa do endereço.

3. Copie a URL montada (`https://…/webhook`) e cadastre-a como destino do webhook de transação
   junto ao suporte.

4. Rode um cenário. O evento aparece no painel em até dois segundos e, quando casa pelo
   `transactionId` ou pelo `orderId`, entra **também** no cartão daquela execução no histórico — é
   ali que se vê a sequência `PENDING` → webhook → `CAPTURED` numa linha do tempo só.

A bancada responde `200` imediatamente e só registra o que chegou: não valida payload, não consulta
a API e não escreve em disco. Isso é de propósito — a plataforma trata timeout e não-2xx como falha
de entrega e reenvia, então um receptor que faz trabalho na requisição vira reentrega.

Os eventos ficam em memória, no máximo 50, e morrem com o processo.

## Consultar uma transação avulsa

O botão *Consultar status* de cada execução só alcança o que aquela aba criou. O painel
**Consultar transação** aceita qualquer identificador — `transactionId`, `orderId`, `tid`,
`integrationId` ou `externalId` — e serve para o caso que mais importa: descobrir o desfecho real de
uma transação que ficou `UNKNOWN` ontem, ou que outra pessoa criou.

## Como ler o resultado

Esta é a parte da integração que mais custa acertar depois, e a bancada foi feita para ensiná-la.

### O desfecho não é o status HTTP

A operação **não lança** para um desfecho conhecido. Aprovação, pendência, recusa, falha e desfecho
indeterminado chegam todos no mesmo envelope:

```json
{
  "success": true,
  "code": 201,
  "data": {
    "status": "DECLINED",
    "outcome": "REFUSED",
    "integrationId": "...",
    "reason": { "code": "CARD_INSUFFICIENT_FUNDS", "category": "ISSUER_REFUSAL", "retryable": true }
  }
}
```

Repare no `201`: **uma recusa do emissor responde `201`**. A chamada funcionou e a transação existe
— o pagamento é que não foi aprovado. Ramifique por `data.outcome`, nunca pelo status HTTP.

Isso vale para os cinco desfechos: a operação que não vira transação viva (`FAILED`) e a que fica
com desfecho indeterminado (`UNKNOWN`) também respondem `201`, com o motivo em `data.reason` e a
transação em `data` — você precisa do `transactionId` dela para consultar e reconciliar depois.

Erro HTTP significa outra coisa: a requisição foi reprovada **antes** de existir transação — payload
inválido, `orderId` repetido, token já consumido. Aí não há `reason`, só a mensagem.

| `outcome` | Significa | O que fazer |
| --- | --- | --- |
| `APPROVED` | Capturada; o dinheiro se moveu | Concluir o pedido |
| `PENDING` | Existe no provedor e ainda vai mudar | Aguardar o webhook ou consultar |
| `REFUSED` | Recusa terminal e conhecida | Oferecer outro cartão |
| `FAILED` | Não virou transação viva no provedor; nada foi cobrado. `status: FAILED` | Corrigir o que o código aponta |
| `UNKNOWN` | Desfecho indeterminado | **Não repetir.** Consultar antes de decidir |

### `UNKNOWN` é a razão de tudo isso existir

Um timeout depois de o pedido sair **não é recusa**: pode existir transação capturada do outro lado,
com o dinheiro do pagador já debitado. Repetir a cobrança nesse ponto cobra a mesma pessoa duas
vezes.

Na bancada, o cenário `,20` com o cartão de final 9 produz exatamente isso — e ao recebê-lo a
interface desabilita Capturar, Cancelar e Copiar body, deixando só Consultar status. É o
comportamento que a sua integração deve ter.

### Leia `reason.code`, não a mensagem do adquirente

`acquirerInfo` é diagnóstico. O cenário `,90` existe para provar por quê: numa recusa por análise de
fraude, o adquirente responde `code: "00"` e `message: "SUCESSO"` — numa transação recusada. Uma tela
que exibe `acquirerInfo.message` diz ao pagador que a recusa dele foi um sucesso.

O motivo verdadeiro está em `reason`: `code` é a chave estável de lógica, `message` é o texto
exibível, e `reason.provider` é diagnóstico que nunca deve aparecer para o pagador. A bancada mostra
os três separados, com o `provider` fechado e rotulado.

`reason.retryable` é sobre **a cobrança**, não sobre repetir a requisição HTTP — e é `false` para
`CARD_PROVIDER_TIMEOUT` de propósito.

### Guarde os identificadores em todo desfecho

`data` e `reason` coexistem: uma recusa traz `integrationId`, `transactionId` e `tid`, e o cenário
`,30` devolve `FAILED` **com** os dados da ordem, porque ela chegou a existir no provedor. Sem esses
identificadores não há reconciliação. A bancada os exibe fora do corpo cru, em toda execução.

O catálogo completo de códigos, com categoria, `retryable` e o status HTTP de cada um, está na
página **Tratamento de erros** da documentação Be.izi, na seção de cartão.

## Segurança

Ambiente de homologação e dados sintéticos apenas — **não use cartões reais**. Os cartões de teste
estão listados na própria página. O PAN não é registrado em log nem enviado ao servidor local, e o
`cardToken` aparece truncado no histórico.

Um aviso sobre o túnel: enquanto ele estiver aberto, **qualquer um com a URL consegue postar** no
seu receptor. Ele não executa nada com o que recebe, guarda no máximo 50 eventos e recusa corpo
acima de 256 KB — mas feche o túnel quando terminar, e não cadastre esse endereço como destino de
nada que não seja homologação. O cabeçalho `authorization` do webhook não é guardado nem exibido,
para o caso de você assinar a entrega.

## Licença

MIT — veja [LICENSE](LICENSE).
