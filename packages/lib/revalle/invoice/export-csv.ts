import { formatRevalleDateTime } from '../date-format';

export const INVOICE_DEFER_CHOICE = 'DEFER';
export const INVOICE_DEFER_LABEL = 'a definir pela contabilidade';

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
];

const BOM = '﻿';

const escapeCell = (value: string) => (/[;"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

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

    return [
      String(row.id),
      row.title,
      row.senderName,
      formatDate(row.sentAt),
      formatDate(row.completedAt),
      row.status,
      isDeferred ? INVOICE_DEFER_LABEL : (row.choice ?? ''),
      isDeferred ? '' : (row.accountName ?? ''),
      isDeferred ? '' : formatKind(row.accountKind),
      row.suggestedCode ?? '',
      row.confidence ?? '',
      formatBoolean(row.acceptedSuggestion),
      row.link,
    ]
      .map(escapeCell)
      .join(';');
  });

  return `${BOM}${[HEADER.join(';'), ...lines].join('\r\n')}\r\n`;
};
