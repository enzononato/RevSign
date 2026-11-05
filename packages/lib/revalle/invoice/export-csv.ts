import { formatRevalleDateTime } from '../date-format';
import { formatInvoiceAmountCsv } from './invoice-data';

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
  /** Fase 8: dados lidos da NF pela IA (podem estar errados; nulos quando a IA não leu). */
  supplierName: string | null;
  invoiceNumber: string | null;
  totalAmountCents: number | null;
  /** Fase 8: chaves de acesso guardadas da NF (saem como no DANFE, em grupos de 4 dígitos, separadas por " / ") e se parece já ter sido enviada. */
  accessKeys: readonly string[];
  isPossibleDuplicate: boolean;
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
  // Fase 8: dados lidos pela IA, de novo no fim.
  'fornecedor',
  'numero_nf',
  'valor',
  // Fase 8: a chave e a marca da duplicada, por último.
  'chave_acesso',
  'possivel_duplicada',
];

const BOM = '﻿';

// Texto que começa com =, +, - ou @ (ou tabulação/CR) o Excel executa como fórmula. Como a neutralização está na função
// de todas as células, nenhuma coluna de texto escapa, nem as que um dia receberem texto lido de um documento. O que é
// número ou data (id, valor `1234,56`, `29/10/2026 14:30`) não começa com esses caracteres.
const FORMULA_START = /^[=+\-@\t\r]/;

const escapeCell = (value: string) => {
  const text = FORMULA_START.test(value) ? `'${value}` : value;

  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

// 44 dígitos seguidos o Excel lê como número (2,92E+43) e perde o final: em grupos de 4, como no DANFE, ele mantém o texto.
const formatAccessKey = (key: string) => key.match(/.{1,4}/g)?.join(' ') ?? key;

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
      row.title,
      row.senderName,
      formatDate(row.sentAt),
      formatDate(row.completedAt),
      row.status,
      row.choice ?? '',
      row.accountName ?? '',
      formatKind(row.accountKind),
      row.suggestedCode ?? '',
      row.confidence ?? '',
      formatBoolean(row.acceptedSuggestion),
      row.link,
      row.financeStatus,
      row.approvedBy ?? '',
      row.costCenterCode ?? '',
      row.costCenterName ?? '',
      row.accountingStatus,
      row.validatedBy ?? '',
      row.supplierName ?? '',
      row.invoiceNumber ?? '',
      row.totalAmountCents === null ? '' : formatInvoiceAmountCsv(row.totalAmountCents),
      row.accessKeys.map(formatAccessKey).join(' / '),
      row.isPossibleDuplicate ? 'sim' : '',
    ]
      .map(escapeCell)
      .join(';');
  });

  return `${BOM}${[HEADER.join(';'), ...lines].join('\r\n')}\r\n`;
};
