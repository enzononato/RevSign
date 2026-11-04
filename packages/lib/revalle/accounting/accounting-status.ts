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

/** Texto da validação do centro de custo (a mesma frase na página e na planilha). */
export const accountingStatusLabel = (row: {
  costCenterCode: string | null;
  costCenterValidatedAt: Date | string | null;
}): string => {
  if (!row.costCenterCode) {
    return 'Sem centro de custo';
  }

  return row.costCenterValidatedAt ? 'Validado' : 'Aguardando validação';
};

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
