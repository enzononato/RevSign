/**
 * Situação da NF na Contabilidade (Fase 7), como a página "Notas fiscais" e a planilha mostram: os mesmos textos nos
 * dois lugares (o app é só pt-BR).
 */

/**
 * Filtro "Validação da Contabilidade" da página e da planilha (parâmetro `contabilidade` da URL). `pendentes` = "Aguardando
 * a Contabilidade", o padrão da página para quem é só da Contabilidade; `todas` desliga esse padrão.
 */
export const ACCOUNTING_FILTERS = ['pendentes', 'validadas', 'todas'] as const;

export type AccountingFilter = (typeof ACCOUNTING_FILTERS)[number];

export const ACCOUNTING_FILTER_LABELS: Record<AccountingFilter, string> = {
  pendentes: 'Aguardando a Contabilidade',
  validadas: 'Validadas',
  todas: 'Todas',
};

export type AccountingValidationRow = {
  costCenterCode: string | null;
  costCenterValidatedAt: Date | string | null;
  /** Status do envelope (`PENDING`, `COMPLETED`, `REJECTED`, `CANCELLED`…). */
  status: string;
  financeStatus: string | null;
  /** Excluída pelo remetente (a versão pendente substituída que o Financeiro escondeu não conta: já é "substituída"). */
  deleted: boolean;
};

export type AccountingValidationState = 'VALIDATED' | 'NO_VALIDATION' | 'NO_COST_CENTER' | 'WAITING';

/**
 * A NF que ninguém mais valida: recusada, cancelada, substituída por uma nova versão ou excluída pelo remetente. Fica
 * fora da fila da Contabilidade (`accountingPendingWhere`), então "Aguardando validação" nela seria mentira.
 */
const isOutOfAccountingQueue = (row: Pick<AccountingValidationRow, 'status' | 'financeStatus' | 'deleted'>) =>
  row.deleted || row.status === 'REJECTED' || row.status === 'CANCELLED' || row.financeStatus === 'SUPERSEDED';

/**
 * Onde a NF está na validação do centro de custo. Uma validação já feita continua valendo em qualquer situação; sem ela,
 * a NF que ninguém mais valida fica em `NO_VALIDATION`, e só a que ainda espera a Contabilidade é `WAITING` (ou
 * `NO_COST_CENTER`, quando falta o primeiro centro).
 */
export const accountingValidationState = (row: AccountingValidationRow): AccountingValidationState => {
  if (isOutOfAccountingQueue(row)) {
    return row.costCenterValidatedAt ? 'VALIDATED' : 'NO_VALIDATION';
  }

  if (!row.costCenterCode) {
    return 'NO_COST_CENTER';
  }

  return row.costCenterValidatedAt ? 'VALIDATED' : 'WAITING';
};

const ACCOUNTING_STATE_LABELS: Record<AccountingValidationState, string> = {
  VALIDATED: 'Validado',
  NO_VALIDATION: 'Sem validação',
  NO_COST_CENTER: 'Sem centro de custo',
  WAITING: 'Aguardando validação',
};

/** Texto da validação do centro de custo (a mesma frase na página e na planilha). */
export const accountingStatusLabel = (row: AccountingValidationRow): string =>
  ACCOUNTING_STATE_LABELS[accountingValidationState(row)];

/**
 * Filtros com que a página "Notas fiscais" abre, sem filtro na URL. Quem é do Financeiro abre na fila do Financeiro,
 * com ou sem a Contabilidade: as duas filas juntas esconderiam as notas de cada uma (a Contabilidade escolhe o filtro
 * dela na mão). Só a Contabilidade abre na fila dela. As chaves são os nomes dos filtros na URL.
 */
export const invoicesDefaultFilters = (profiles: {
  isFinance: boolean;
  isAccounting: boolean;
}): { financeiro?: 'pendentes'; contabilidade?: 'pendentes' } => {
  if (profiles.isFinance) {
    return { financeiro: 'pendentes' };
  }

  return profiles.isAccounting ? { contabilidade: 'pendentes' } : {};
};
