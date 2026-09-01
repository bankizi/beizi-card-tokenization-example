/**
 * Os cenários do provedor simulado.
 *
 * Dois eixos que não se atropelam: o último dígito do cartão escolhe a autorização, e os centavos
 * do valor escolhem o detalhe — motivo da recusa quando recusa, trajetória dos recebíveis quando
 * aprova. Como só um desfecho acontece por transação, os centavos nunca significam as duas coisas.
 */

/** Cartões de teste, um por cenário de autorização. Todos Luhn-válidos e de BIN Visa. */
export const AUTHORIZATION = [
  {
    digit: '0',
    number: '4000000000000010',
    label: 'Aprovada e capturada',
    outcome: 'sincrono',
    detail: 'Cenário base. Captura na resposta da criação.',
  },
  {
    digit: '1',
    number: '4000000000000051',
    label: 'Aprovada e capturada',
    outcome: 'sincrono',
    detail: 'Segundo cartão de aprovação, para alternar entre execuções.',
  },
  {
    digit: '2',
    number: '4000000000000002',
    label: 'Pré-autorizada',
    outcome: 'sincrono',
    detail: 'Envie com capture=false e depois use a ação Capturar.',
    suggestsCapture: false,
  },
  {
    digit: '3',
    number: '4000000000000093',
    label: 'Recusada',
    outcome: 'sincrono',
    detail: 'O motivo vem dos centavos do valor.',
    usesDeclineCents: true,
  },
  {
    digit: '4',
    number: '4000000000000044',
    label: 'Em análise, aprovada depois',
    outcome: 'assincrono',
    detail: 'O desfecho chega alguns segundos depois. Use o polling.',
  },
  {
    digit: '5',
    number: '4000000000000085',
    label: 'Em análise, recusada depois',
    outcome: 'assincrono',
    detail: 'O desfecho chega alguns segundos depois. Use o polling.',
  },
  {
    digit: '6',
    number: '4000000000000036',
    label: 'Captura parcial',
    outcome: 'sincrono',
    detail: 'Não gera cronograma de recebíveis.',
  },
  {
    digit: '7',
    number: '4000000000000077',
    label: 'Capturada e depois estornada',
    outcome: 'assincrono',
    detail: 'Chargeback do emissor, alguns segundos depois.',
  },
  {
    digit: '8',
    number: '4000000000000028',
    label: 'Capturada e depois contestada',
    outcome: 'assincrono',
    detail: 'Disputa, alguns segundos depois.',
  },
  {
    digit: '9',
    number: '4000000000000069',
    label: 'Erro do provedor',
    outcome: 'erro',
    detail: 'A criação falha. Serve para testar o caminho de erro.',
  },
];

/** Centavos, quando a transação recusa: viram o código do adquirente. */
export const DECLINE = [
  { cents: '05', label: 'Não autorizada' },
  { cents: '51', label: 'Saldo ou limite insuficiente' },
  { cents: '54', label: 'Cartão expirado' },
  { cents: '57', label: 'Transação não permitida' },
  { cents: '62', label: 'Cartão restrito' },
  { cents: '82', label: 'Código de segurança inválido' },
];

/** Centavos, quando a transação aprova: escolhem a trajetória dos recebíveis. */
export const RECEIVABLES = [
  { cents: '00', label: 'Todas as parcelas liquidam', highlight: false },
  { cents: '01', label: 'Parcela 1 falha e liquida na retentativa', highlight: false },
  { cents: '02', label: 'Parcela 1 bloqueia, libera e liquida', highlight: true, note: 'Único caminho que passa pelo status RELEASED' },
  { cents: '03', label: 'Nenhuma parcela liquida', highlight: false },
  { cents: '04', label: 'Parcela 1 liquida e depois é estornada', highlight: false },
  { cents: '05', label: 'Cronograma com retenção sinalizada', highlight: false },
  { cents: '06', label: 'Captura sem cronograma', highlight: true, note: 'O provedor não devolve cronograma; o previsto é calculado pela Be.izi' },
  { cents: '07', label: 'Valor liquidado divergente', highlight: true, note: 'O valor liquidado difere do previsto no cronograma' },
  { cents: '08', label: 'Data prevista divergente', highlight: true, note: 'A data de liquidação difere da prevista no cronograma' },
];

/**
 * O valor é montado como `<parte inteira><centavos>`. A parte inteira é livre, mas o líquido da
 * primeira parcela precisa superar 500 centavos depois das taxas — por isso o padrão é alto.
 */
export const DEFAULT_MAJOR_UNITS = 300;

export function buildAmount(majorUnits, cents) {
  return Number(majorUnits) * 100 + Number(cents);
}

export function formatBRL(amountInCents) {
  return (amountInCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
