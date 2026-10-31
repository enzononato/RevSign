/**
 * Situação da NF no Financeiro (Fase 6), como a página "Notas fiscais", a página da NF e a planilha mostram. Os mesmos
 * textos nos três lugares (o app é só pt-BR).
 */
export const FINANCE_STATUSES = ['AWAITING_ACCOUNT', 'PENDING_APPROVAL', 'APPROVED', 'SUPERSEDED', 'LEGACY'] as const;

export type FinanceStatus = (typeof FINANCE_STATUSES)[number];

export const FINANCE_STATUS_LABELS: Record<FinanceStatus, string> = {
  AWAITING_ACCOUNT: 'Aguardando a conta',
  PENDING_APPROVAL: 'Aguardando aprovação',
  APPROVED: 'Aprovada',
  SUPERSEDED: 'Substituída',
  LEGACY: 'Antiga, sem aprovação',
};

/**
 * Texto da situação de uma NF. Rascunho aprovado = o envio do Financeiro (ou da nova versão) ainda não saiu; recusada
 * antes da aprovação não aguarda mais nada. Sem estado (NF de antes da Fase 6 em rascunho, ou não é NF): vazio.
 */
export const financeStatusLabel = (financeStatus: FinanceStatus | null, envelopeStatus: string): string => {
  if (!financeStatus) {
    return '';
  }

  if (financeStatus === 'APPROVED' && envelopeStatus === 'DRAFT') {
    return 'Aprovada, ainda não enviada';
  }

  if (
    (financeStatus === 'PENDING_APPROVAL' || financeStatus === 'AWAITING_ACCOUNT') &&
    (envelopeStatus === 'REJECTED' || envelopeStatus === 'CANCELLED')
  ) {
    return 'Sem aprovação (recusada)';
  }

  return FINANCE_STATUS_LABELS[financeStatus];
};

/**
 * Filtro "Situação no Financeiro" da página e da planilha (parâmetro `financeiro` da URL). `pendentes` = "Aguardando o
 * Financeiro" (definir a conta ou aprovar), o padrão da página para quem é do Financeiro; `todas` desliga esse padrão.
 */
export const FINANCE_FILTERS = [
  'pendentes',
  'aguardando-conta',
  'aguardando-aprovacao',
  'aprovadas',
  'substituidas',
  'antigas',
  'todas',
] as const;

export type FinanceFilter = (typeof FINANCE_FILTERS)[number];

export const FINANCE_FILTER_LABELS: Record<FinanceFilter, string> = {
  pendentes: 'Aguardando o Financeiro',
  'aguardando-conta': 'Aguardando a conta',
  'aguardando-aprovacao': 'Aguardando aprovação',
  aprovadas: 'Aprovadas',
  substituidas: 'Substituídas',
  antigas: 'Antigas, sem aprovação',
  todas: 'Todas',
};

/** Padrão da página para quem é do Financeiro (sem `financeiro` na URL). */
export const FINANCE_DEFAULT_FILTER: FinanceFilter = 'pendentes';

/** Página da NF só de leitura (Financeiro e quem está na NF): a lista e os e-mails do Financeiro levam a ela. */
export const invoiceViewPath = (envelopeId: string) => `/notas-fiscais/${envelopeId}`;
