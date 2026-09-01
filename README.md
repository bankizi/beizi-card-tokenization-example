# Bancada de testes de cartão — Be.izi

Exemplo executável do SDK [`@be.izi/card-tokenization`](https://www.npmjs.com/package/@be.izi/card-tokenization).
A bancada roda na sua máquina e reproduz o mesmo desenho da integração real: o cartão é tokenizado
no navegador pelo SDK e a transação é criada a partir do lado servidor.

Com ela dá para percorrer todos os cenários de cartão em homologação — aprovação, pré-autorização,
recusa por motivo, análise assíncrona, estorno, contestação e as nove trajetórias de recebíveis — e
ver, em cada passo, o corpo enviado, a resposta e a latência.

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
- rodar os nove cenários de recebível em sequência com um clique;
- ver o que foi enviado e recebido em cada passo, com latência;
- consultar o status depois, para os cenários cujo desfecho é assíncrono;
- copiar o body para reproduzir fora da bancada.

## Segurança

Ambiente de homologação e dados sintéticos apenas — **não use cartões reais**. Os cartões de teste
estão listados na própria página. O PAN não é registrado em log nem enviado ao servidor local, e o
`cardToken` aparece truncado no histórico.

## Licença

MIT — veja [LICENSE](LICENSE).
