import { formatRevalleDateTime } from '../date-format';

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
  /** Fase 7: centro de custo (código e nome da lista fixa), situação da validação (texto da tela) e quem validou. */
  costCenterCode: string | null;
  costCenterName: string | null;
  accountingStatus: string;
  validatedBy: string | null;
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
  // Fase 7: de novo no fim.
  'centro_custo',
  'nome_centro_custo',
  'validacao_contabilidade',
  'validado_por',
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
    return [
      String(row.id),
      safeText(row.title),
      safeText(row.senderName),
      formatDate(row.sentAt),
      formatDate(row.completedAt),
      row.status,
      safeText(row.choice ?? ''),
      safeText(row.accountName ?? ''),
      formatKind(row.accountKind),
      safeText(row.suggestedCode ?? ''),
      row.confidence ?? '',
      formatBoolean(row.acceptedSuggestion),
      row.link,
      row.financeStatus,
      safeText(row.approvedBy ?? ''),
      safeText(row.costCenterCode ?? ''),
      safeText(row.costCenterName ?? ''),
      row.accountingStatus,
      safeText(row.validatedBy ?? ''),
    ]
      .map(escapeCell)
      .join(';');
  });

  return `${BOM}${[HEADER.join(';'), ...lines].join('\r\n')}\r\n`;
};
