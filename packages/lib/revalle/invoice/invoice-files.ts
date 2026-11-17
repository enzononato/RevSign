import type { RevalleInvoiceFile } from '@prisma/client';

import type { FinanceStatus } from '../finance/finance-status';

/**
 * Fase 9: várias notas fiscais (e boletos) no mesmo envio. Cada arquivo do envio tem uma linha (`RevalleInvoiceFile`)
 * com o tipo e tudo que é "da nota"; a linha do envio (`RevalleInvoiceClassification`) guarda o que é do envio e o
 * espelho (cópia da nota única; nulo com várias). Aqui ficam as contas puras sobre essas linhas.
 */

export type InvoiceFileKind = 'NF' | 'BOLETO' | 'OTHER' | 'UNKNOWN';

export type InvoiceSuggestionStatus = 'PENDING' | 'DONE' | 'FAILED' | 'SKIPPED';

/** Posição de uma nota entre as notas do envio (1 de 3, 2 de 3...). Só arquivos NF têm posição. */
export type InvoicePosition = { index: number; total: number };

/** O envio é NF se tem pelo menos uma; sem NF, um arquivo sem texto deixa em dúvida; senão (ou vazio), não é. */
export const aggregateIsInvoice = (kinds: InvoiceFileKind[]): 'YES' | 'NO' | 'UNKNOWN' => {
  if (kinds.includes('NF')) {
    return 'YES';
  }

  return kinds.includes('UNKNOWN') ? 'UNKNOWN' : 'NO';
};

/** Situação da IA no envio: alguma lendo = lendo; senão alguma falhou = falhou; senão alguma pronta = pronta. */
export const aggregateSuggestionStatus = (statuses: InvoiceSuggestionStatus[]): InvoiceSuggestionStatus => {
  for (const status of ['PENDING', 'FAILED', 'DONE'] as const) {
    if (statuses.includes(status)) {
      return status;
    }
  }

  return 'SKIPPED';
};

/** As NFs do envio, na ordem dos arquivos (desempate pelo id), com a posição de cada uma. Chave = id da linha. */
export const invoicePositions = (
  files: Array<{ id: string; kind: InvoiceFileKind; order: number }>,
): Map<string, InvoicePosition> => {
  const nfs = files
    .filter((file) => file.kind === 'NF')
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return new Map(nfs.map((file, i) => [file.id, { index: i + 1, total: nfs.length }]));
};

export const formatInvoicePosition = (position: InvoicePosition): string =>
  `nota ${position.index} de ${position.total}`;

/**
 * Situação de uma nota no Financeiro. A do envio vale para todas, salvo enquanto o envio aguarda: a nota que já tem a
 * aprovação dela está aprovada. `APPROVED` sem `approvedAt` (a reserva solta da nova versão) continua aprovada.
 */
export const fileFinanceStatus = (
  envelope: FinanceStatus | null,
  approvedAt: Date | string | null,
): FinanceStatus | null => {
  if (envelope === 'PENDING_APPROVAL' && approvedAt !== null) {
    return 'APPROVED';
  }

  return envelope;
};

/** As colunas "da nota" que a linha do envio espelha. */
export type InvoiceMirrorSource = Pick<
  RevalleInvoiceFile,
  | 'suggestionStatus'
  | 'suggestion'
  | 'suggestionAttempts'
  | 'supplierName'
  | 'invoiceNumber'
  | 'totalAmountCents'
  | 'accessKeys'
  | 'choiceCode'
  | 'choiceById'
  | 'choiceAt'
  | 'acceptedSuggestion'
  | 'costCenterCode'
  | 'costCenterById'
  | 'costCenterAt'
  | 'costCenterValidatedAt'
  | 'costCenterValidatedById'
  | 'costCenterValidatedByName'
  | 'approvedById'
  | 'approvedAt'
  | 'approvedAccountName'
  | 'approvedByName'
>;

const latestDate = (dates: Date[]): Date =>
  dates.reduce((latest, date) => (date.getTime() > latest.getTime() ? date : latest));

/**
 * O espelho da linha do envio, a partir das NFs (na ordem dos arquivos):
 * - uma nota: as colunas dela, iguais (o envio de uma nota fica exatamente como antes da Fase 9);
 * - nenhuma: tudo vazio, IA `SKIPPED`;
 * - duas ou mais: o que é de uma nota fica nulo; as chaves de acesso somam (sem repetir, na ordem); a IA é a situação
 *   agregada e as tentativas, a soma; `approvedAt` é a última aprovação quando TODAS as notas estão aprovadas (é o que a
 *   varredura de selagem lê), senão nulo; quem aprovou e os nomes ficam nulos.
 */
export const invoiceMirrorColumns = (nfFiles: InvoiceMirrorSource[]): InvoiceMirrorSource => {
  if (nfFiles.length === 1) {
    const [only] = nfFiles;

    return {
      suggestionStatus: only.suggestionStatus,
      suggestion: only.suggestion,
      suggestionAttempts: only.suggestionAttempts,
      supplierName: only.supplierName,
      invoiceNumber: only.invoiceNumber,
      totalAmountCents: only.totalAmountCents,
      accessKeys: [...only.accessKeys],
      choiceCode: only.choiceCode,
      choiceById: only.choiceById,
      choiceAt: only.choiceAt,
      acceptedSuggestion: only.acceptedSuggestion,
      costCenterCode: only.costCenterCode,
      costCenterById: only.costCenterById,
      costCenterAt: only.costCenterAt,
      costCenterValidatedAt: only.costCenterValidatedAt,
      costCenterValidatedById: only.costCenterValidatedById,
      costCenterValidatedByName: only.costCenterValidatedByName,
      approvedById: only.approvedById,
      approvedAt: only.approvedAt,
      approvedAccountName: only.approvedAccountName,
      approvedByName: only.approvedByName,
    };
  }

  const approvals = nfFiles.map((file) => file.approvedAt);
  const allApproved = approvals.length > 0 && approvals.every((date): date is Date => date !== null);

  return {
    suggestionStatus: aggregateSuggestionStatus(nfFiles.map((file) => file.suggestionStatus)),
    suggestion: null,
    suggestionAttempts: nfFiles.reduce((sum, file) => sum + file.suggestionAttempts, 0),
    supplierName: null,
    invoiceNumber: null,
    totalAmountCents: null,
    accessKeys: [...new Set(nfFiles.flatMap((file) => file.accessKeys))],
    choiceCode: null,
    choiceById: null,
    choiceAt: null,
    acceptedSuggestion: null,
    costCenterCode: null,
    costCenterById: null,
    costCenterAt: null,
    costCenterValidatedAt: null,
    costCenterValidatedById: null,
    costCenterValidatedByName: null,
    approvedById: null,
    approvedAt: allApproved ? latestDate(approvals as Date[]) : null,
    approvedAccountName: null,
    approvedByName: null,
  };
};
