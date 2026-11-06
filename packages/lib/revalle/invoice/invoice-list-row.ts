/**
 * Redesign v3: o que cada cartão da lista "Notas fiscais" mostra (título, ação e encaixes de quem assina). Só lê a linha
 * que `findInvoices` devolve; quem decide permissão continua sendo o servidor e a página da NF.
 */

export type InvoiceListRowSigner = {
  name: string;
  email: string;
  signingStatus: 'NOT_SIGNED' | 'SIGNED' | 'REJECTED';
};

export type InvoiceListRowState = {
  status: 'PENDING' | 'COMPLETED' | 'REJECTED' | 'CANCELLED' | 'DRAFT';
  financeStatus: 'PENDING_APPROVAL' | 'APPROVED' | 'SUPERSEDED' | 'LEGACY' | null;
  deleted: boolean;
  costCenterValidatedAt: Date | string | null;
  recipients: InvoiceListRowSigner[];
};

export type InvoiceListViewer = { isFinance: boolean; isAccounting: boolean };

export type InvoiceRowAction =
  | { kind: 'approve' }
  | { kind: 'validate' }
  | { kind: 'resend' }
  | { kind: 'waiting'; firstName: string | null }
  | { kind: 'completed' }
  | { kind: 'rejected' }
  | { kind: 'superseded' }
  | { kind: 'cancelled' }
  | { kind: 'draft' };

const SENT_STATUSES: InvoiceListRowState['status'][] = ['PENDING', 'COMPLETED'];

/** Rascunho na lista só aparece quando é a nova versão parada (`newVersionDraftWhere`): ela espera as duas filas. */
const isNewVersionDraft = (row: InvoiceListRowState) =>
  row.status === 'DRAFT' && (row.financeStatus === 'APPROVED' || row.financeStatus === 'PENDING_APPROVAL');

/** Espelha `financePendingWhere`. */
export const isAwaitingFinance = (row: InvoiceListRowState) =>
  !row.deleted &&
  ((row.financeStatus === 'PENDING_APPROVAL' && SENT_STATUSES.includes(row.status)) || isNewVersionDraft(row));

/** Espelha `accountingPendingWhere`. */
export const isAwaitingAccounting = (row: InvoiceListRowState) =>
  !row.deleted &&
  ((row.costCenterValidatedAt === null &&
    row.financeStatus !== 'SUPERSEDED' &&
    SENT_STATUSES.includes(row.status) &&
    !row.recipients.some((recipient) => recipient.signingStatus === 'REJECTED')) ||
    isNewVersionDraft(row));

/** Primeiro nome; sem nome, a parte do e-mail antes do @. */
export const signerFirstName = ({ name, email }: Pick<InvoiceListRowSigner, 'name' | 'email'>) => {
  const fromName = name.trim().split(/\s+/)[0];

  if (fromName) {
    return fromName;
  }

  return email.split('@')[0] || email;
};

/**
 * A pílula do cartão: a ação de quem vê (Financeiro aprova a conta antes da Contabilidade validar o centro, quando a pessoa
 * tem os dois perfis) ou, sem ação, onde a nota está. A ordem das filas é a de `financePendingWhere` e
 * `accountingPendingWhere`: mudar uma exige mudar a outra.
 */
export const invoiceRowAction = (row: InvoiceListRowState, viewer: InvoiceListViewer): InvoiceRowAction => {
  // A nova versão parada já tem conta e centro: o que falta, nas duas filas, é o "Enviar de novo" da página da NF.
  if ((viewer.isFinance || viewer.isAccounting) && !row.deleted && isNewVersionDraft(row)) {
    return { kind: 'resend' };
  }

  if (viewer.isFinance && isAwaitingFinance(row)) {
    return { kind: 'approve' };
  }

  if (viewer.isAccounting && isAwaitingAccounting(row)) {
    return { kind: 'validate' };
  }

  if (row.financeStatus === 'SUPERSEDED') {
    return { kind: 'superseded' };
  }

  switch (row.status) {
    case 'REJECTED':
      return { kind: 'rejected' };
    case 'CANCELLED':
      return { kind: 'cancelled' };
    case 'COMPLETED':
      return { kind: 'completed' };
    case 'DRAFT':
      return { kind: 'draft' };
    default: {
      const next = row.recipients.find((recipient) => recipient.signingStatus === 'NOT_SIGNED');

      return { kind: 'waiting', firstName: next ? signerFirstName(next) : null };
    }
  }
};

export type InvoiceAiTitleData = { supplierName: string | null; invoiceNumber: string | null };

/** "NF 123 · Fornecedor" com o que a IA leu; sem número nem fornecedor, `null` (vale o título do documento). */
export const invoiceAiTitle = (data: InvoiceAiTitleData | null | undefined): string | null => {
  const number = data?.invoiceNumber?.trim();
  const supplier = data?.supplierName?.trim();

  if (number && supplier) {
    return `NF ${number} · ${supplier}`;
  }

  if (number) {
    return `NF ${number}`;
  }

  return supplier || null;
};

export type InvoiceSignerSummary = { total: number; signed: number; pending: number; rejected: number };

export const invoiceSignerSummary = (recipients: InvoiceListRowSigner[]): InvoiceSignerSummary => ({
  total: recipients.length,
  signed: recipients.filter((recipient) => recipient.signingStatus === 'SIGNED').length,
  pending: recipients.filter((recipient) => recipient.signingStatus === 'NOT_SIGNED').length,
  rejected: recipients.filter((recipient) => recipient.signingStatus === 'REJECTED').length,
});
