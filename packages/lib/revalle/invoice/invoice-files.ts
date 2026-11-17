import type { RevalleInvoiceFile } from '@prisma/client';

import type { FinanceStatus } from '../finance/finance-status';
import type { InvoiceDetection, InvoiceSignal } from './detect-invoice';

/**
 * Fase 9: várias notas fiscais (e boletos) no mesmo envio. Cada arquivo do envio tem uma linha (`RevalleInvoiceFile`)
 * com o tipo e tudo que é "da nota"; a linha do envio (`RevalleInvoiceClassification`) guarda o que é do envio e o
 * espelho (cópia da nota única; nulo com várias). Aqui ficam as contas puras sobre essas linhas.
 */

export type InvoiceFileKind = 'NF' | 'BOLETO' | 'OTHER' | 'UNKNOWN';

export type InvoiceSuggestionStatus = 'PENDING' | 'DONE' | 'FAILED' | 'SKIPPED';

/** Posição de uma nota entre as notas do envio (1 de 3, 2 de 3...). Só arquivos NF têm posição. */
export type InvoicePosition = { index: number; total: number };

// Sinais que só uma nota fiscal tem. `NF_CNPJ_VALOR` (CNPJ, "nota fiscal", R$ e termos de nota) também aparece num boleto
// que cita a nota, então sozinho perde para o boleto.
const STRONG_INVOICE_SIGNALS: InvoiceSignal[] = ['CHAVE_ACESSO', 'DANFE', 'NFSE'];

/**
 * Tipo de um arquivo pelo texto: sinal forte de nota → NF (um PDF com DANFE e boleto juntos é nota); senão boleto →
 * BOLETO; senão o sinal fraco de nota → NF; senão sem texto → UNKNOWN (o remetente diz); senão OTHER.
 */
export const classifyFileKind = ({
  detection,
  boleto,
  isSparse,
}: {
  detection: InvoiceDetection;
  boleto: { isBoleto: boolean };
  isSparse: boolean;
}): InvoiceFileKind => {
  if (detection.signals.some((signal) => STRONG_INVOICE_SIGNALS.includes(signal))) {
    return 'NF';
  }

  if (boleto.isBoleto) {
    return 'BOLETO';
  }

  if (detection.status === 'YES') {
    return 'NF';
  }

  return isSparse ? 'UNKNOWN' : 'OTHER';
};

/**
 * Onde fica a nota ao refazer as linhas de um envio NF de antes da Fase 9 (vários arquivos): o primeiro que o texto
 * reconhece como NF; senão o primeiro sem texto (escaneado); só então o primeiro arquivo. Neste último caso, um arquivo
 * com texto que não parece nota (um contrato) não pode ir sozinho para a IA (`canAutoRead` falso): antes da Fase 9, sem
 * nota pelo texto, só os escaneados iam. Nulo sem arquivo.
 */
export const pickLegacyInvoiceFile = <T extends { isSparse: boolean; detection: Pick<InvoiceDetection, 'status'> }>(
  contents: T[],
): { invoice: T; canAutoRead: boolean } | null => {
  const invoice =
    contents.find((content) => content.detection.status === 'YES') ??
    contents.find((content) => content.isSparse) ??
    contents[0];

  if (!invoice) {
    return null;
  }

  return { invoice, canAutoRead: invoice.detection.status === 'YES' || invoice.isSparse };
};

/**
 * Os arquivos que viram nota quando o dono marca como NF um envio já enviado sem dizer qual: os sem texto; senão os que
 * têm sinal de nota (fora boletos); senão o primeiro que não é boleto; só então o primeiro.
 */
export const pickSentInvoiceTargets = <T extends { kind: InvoiceFileKind; signals: string[] }>(rows: T[]): T[] => {
  const unknown = rows.filter((row) => row.kind === 'UNKNOWN');

  if (unknown.length > 0) {
    return unknown;
  }

  const withSignals = rows.filter((row) => row.kind !== 'BOLETO' && row.signals.length > 0);

  if (withSignals.length > 0) {
    return withSignals;
  }

  return [rows.find((row) => row.kind !== 'BOLETO') ?? rows[0]].filter((row) => row !== undefined);
};

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

/** Título da linha da planilha: com uma nota, o do envio (como antes); com várias, `Compra · nota 2 de 3`. */
export const invoiceRowTitle = (title: string, position: InvoicePosition): string =>
  position.total > 1 ? `${title} · ${formatInvoicePosition(position)}` : title;

/**
 * A mesma nota duas vezes no envio: a posição (1, 2...) da NF anterior com o mesmo arquivo (SHA-256) ou uma chave de
 * acesso em comum. `files` na ordem dos arquivos. Nulo para a primeira de cada par, para quem não é NF e sem dado (nulo
 * não casa).
 */
export const sameEnvelopeDuplicateIndex = (
  files: Array<{ id: string; kind: InvoiceFileKind; fileSha256: string | null; accessKeys: string[] }>,
  fileId: string,
): number | null => {
  const nfs = files.filter((file) => file.kind === 'NF');
  const at = nfs.findIndex((file) => file.id === fileId);

  if (at < 0) {
    return null;
  }

  const self = nfs[at];

  for (let index = 0; index < at; index += 1) {
    const other = nfs[index];
    const sameFile = self.fileSha256 !== null && self.fileSha256 === other.fileSha256;

    if (sameFile || self.accessKeys.some((key) => other.accessKeys.includes(key))) {
      return index + 1;
    }
  }

  return null;
};

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
