import { formatRevalleDateTime } from '../date-format';
import { FINANCE_STATUS_LABELS } from '../finance/finance-status';

export const INVOICE_DEFER_CHOICE = 'DEFER';
export const INVOICE_DEFER_LABEL = 'a definir pelo Financeiro';
/** NF de antes da Fase 6 deixada para a contabilidade (`LEGACY`): conclui sem o Financeiro, a decisão é da contabilidade. */
export const INVOICE_LEGACY_DEFER_LABEL = 'a definir pela contabilidade';

export type InvoiceExportRow = {
  id: number | string;
  title: string;
  senderName: string;
  sentAt: Date | null;
  completedAt: Date | null;
  status: string;
  choice: string | null;
  accountName: string | null;
  accountKind: 'PAYABLE' | 'RECEIVABLE' | null;
  suggestedCode: string | null;
  confidence: string | null;
  acceptedSuggestion: boolean | null;
  link: string;
  /** Fase 6: situação no Financeiro (texto da tela) e quem do Financeiro aprovou (ou definiu) a conta. */
  financeStatus: string;
  approvedBy: string | null;
};

const HEADER = [
  'id',
  'titulo',
  'remetente',
  'enviado_em',
  'concluido_em',
  'status',
  'conta',
  'nome_conta',
  'tipo',
  'sugestao_ia',
  'confianca',
  'aceitou_sugestao',
  'link',
  // Fase 6: sempre no fim, para não deslocar as colunas que a contabilidade já usa.
  'financeiro',
  'aprovado_por',
];

const BOM = '﻿';

const escapeCell = (value: string) => (/[;"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

const FORMULA_START = /^[=+\-@\t\r]/;

const safeText = (value: string) => (FORMULA_START.test(value) ? `'${value}` : value);

const formatDate = (date: Date | null) => (date ? formatRevalleDateTime(date) : '');

const formatKind = (kind: InvoiceExportRow['accountKind']) => {
  if (kind === 'PAYABLE') {
    return 'pagar';
  }

  return kind === 'RECEIVABLE' ? 'receber' : '';
};

const formatBoolean = (value: boolean | null) => {
  if (value === null) {
    return '';
  }

  return value ? 'sim' : 'não';
};

export const buildInvoiceExportCsv = (rows: InvoiceExportRow[]): string => {
  const lines = rows.map((row) => {
    const isDeferred = row.choice === INVOICE_DEFER_CHOICE;
    const deferLabel =
      row.financeStatus === FINANCE_STATUS_LABELS.LEGACY ? INVOICE_LEGACY_DEFER_LABEL : INVOICE_DEFER_LABEL;

    return [
      String(row.id),
      safeText(row.title),
      safeText(row.senderName),
      formatDate(row.sentAt),
      formatDate(row.completedAt),
      row.status,
      isDeferred ? deferLabel : safeText(row.choice ?? ''),
      isDeferred ? '' : safeText(row.accountName ?? ''),
      isDeferred ? '' : formatKind(row.accountKind),
      safeText(row.suggestedCode ?? ''),
      row.confidence ?? '',
      formatBoolean(row.acceptedSuggestion),
      row.link,
      row.financeStatus,
      safeText(row.approvedBy ?? ''),
    ]
      .map(escapeCell)
      .join(';');
  });

  return `${BOM}${[HEADER.join(';'), ...lines].join('\r\n')}\r\n`;
};
