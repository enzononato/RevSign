import type { RevalleInvoiceClassification, RevalleInvoiceFile } from '@prisma/client';

import { costCenterLabel } from '../invoice/cost-centers';
import type { InvoiceFileKind } from '../invoice/invoice-files';

/** Motivo de uma nova versão (troca de conta ou correção do centro): obrigatório, 10 a 500 caracteres depois de `trim`. */
export const CHANGE_REASON_MIN = 10;
export const CHANGE_REASON_MAX = 500;
export const CHANGE_REASON_MESSAGE = 'Escreva o motivo (de 10 a 500 caracteres).';

export const isValidChangeReason = (reason: string) => {
  const length = reason.trim().length;

  return length >= CHANGE_REASON_MIN && length <= CHANGE_REASON_MAX;
};

export const formatInvoiceAccount = (code: string, name: string | null | undefined) =>
  name ? `${code} – ${name}` : code;

const VERSION_SUFFIX = /\s\(v\d+\)$/;

/** Título da nova versão: título base + " (vN)". O sufixo de uma versão anterior é trocado, nunca empilhado. */
export const nextVersionTitle = (title: string, version: number) =>
  `${title.replace(VERSION_SUFFIX, '')} (v${version})`;

export type VersionChangeLine =
  | { kind: 'ACCOUNT'; title: string; from: string | null; to: string }
  | { kind: 'COST_CENTER'; fromCode: string; toCode: string };

/** Fase 9: a nota que mudou, só num envio com 2+ notas (com uma, a frase é a de antes). */
export type VersionChangeDocument = { index: number; total: number; title: string };

export type VersionChangeNotice = VersionChangeLine & { document?: VersionChangeDocument };

/** A frase do que mudou, igual para todos que recebem o aviso. `from` nulo: a versão trocada não tinha conta. */
export const versionChangeNoticeLine = (change: VersionChangeNotice) => {
  const doc = change.document;

  if (change.kind === 'COST_CENTER') {
    const from = costCenterLabel(change.fromCode);
    const to = costCenterLabel(change.toCode);

    return doc
      ? `O centro de custo da nota ${doc.index} de ${doc.total} (${doc.title}) foi corrigido de ${from} para ${to}.`
      : `O centro de custo foi corrigido de ${from} para ${to}.`;
  }

  const account = change.from
    ? `alterada pelo Financeiro de ${change.from} para ${change.to}`
    : `definida pelo Financeiro: ${change.to}`;
  const note = doc ? ` (nota ${doc.index} de ${doc.total}: ${doc.title})` : '';

  return `A conta contábil da nota fiscal ${change.title}${note} foi ${account}.`;
};

/**
 * Texto exato do aviso de uma nova versão (e-mail para o remetente e os destinatários das duas versões). O ponto final
 * do modelo não é dobrado quando o motivo já termina com pontuação.
 */
export const buildVersionChangeNotice = (change: VersionChangeNotice, reason: string) => {
  const text = reason.trim();
  const ending = /[.!?…]$/.test(text) ? '' : '.';

  return `${versionChangeNoticeLine(change)} Motivo: ${text}${ending}`;
};

export const buildAccountChangeNotice = ({
  title,
  from,
  to,
  reason,
}: {
  title: string;
  from: string | null;
  to: string;
  reason: string;
}) => buildVersionChangeNotice({ kind: 'ACCOUNT', title, from, to }, reason);

export type InvoiceVersionChange = { kind: 'ACCOUNT'; code: string } | { kind: 'COST_CENTER'; code: string };

type VersionRow = Pick<
  RevalleInvoiceClassification,
  | 'choiceCode'
  | 'choiceById'
  | 'choiceAt'
  | 'costCenterCode'
  | 'costCenterById'
  | 'costCenterAt'
  | 'costCenterValidatedAt'
  | 'costCenterValidatedById'
  | 'costCenterValidatedByName'
  | 'financeStatus'
  | 'approvedById'
  | 'approvedAt'
  | 'approvedAccountName'
  | 'approvedByName'
>;

/**
 * A situação no Financeiro que a correção do centro leva para a nova versão. `APPROVED` só com a aprovação na linha: a
 * retomada lê a linha já marcada `SUPERSEDED`, e a marca não apaga a aprovação. Todo o resto aguarda o Financeiro,
 * inclusive a NF `LEGACY`: é uma nova versão que todos assinam agora, e o envio nunca deixa uma NF pular o Financeiro.
 */
const inheritedFinanceStatus = (row: Pick<VersionRow, 'financeStatus' | 'approvedAt'>) =>
  row.financeStatus === 'APPROVED' || (row.financeStatus === 'SUPERSEDED' && row.approvedAt !== null)
    ? ('APPROVED' as const)
    : ('PENDING_APPROVAL' as const);

/**
 * O que muda na classificação da nova versão, conforme quem mudou (spec da Fase 7, seção 2):
 *
 * | Quem mudou                      | Conta   | Situação no Financeiro           | Centro  | Validação               |
 * | Financeiro trocou a conta       | a nova  | aprovada por quem trocou         | o mesmo | a mesma da anterior     |
 * | Contabilidade corrigiu o centro | a mesma | a mesma da anterior (nomes iguais) | o novo | validado por quem corrigiu |
 *
 * Exceção da spec: a NF `LEGACY` corrigida sai aguardando o Financeiro (`inheritedFinanceStatus`).
 */
export const nextClassification = (
  row: VersionRow,
  change: InvoiceVersionChange,
  user: { id: number; name: string | null },
  now: Date,
  accountName: string | null,
) => {
  const userName = user.name?.trim() || null;

  if (change.kind === 'ACCOUNT') {
    return {
      choiceCode: change.code,
      choiceById: user.id,
      choiceAt: now,
      // A NF que não tinha centro continua sem: o envio da nova versão não o exige.
      costCenterCode: row.costCenterCode,
      costCenterById: row.costCenterById,
      costCenterAt: row.costCenterAt,
      costCenterValidatedAt: row.costCenterValidatedAt,
      costCenterValidatedById: row.costCenterValidatedById,
      costCenterValidatedByName: row.costCenterValidatedByName,
      financeStatus: 'APPROVED' as const,
      approvedById: user.id,
      approvedAt: now,
      approvedAccountName: accountName,
      approvedByName: userName,
    };
  }

  return {
    choiceCode: row.choiceCode,
    choiceById: row.choiceById,
    choiceAt: row.choiceAt,
    costCenterCode: change.code,
    costCenterById: user.id,
    costCenterAt: now,
    costCenterValidatedAt: now,
    costCenterValidatedById: user.id,
    costCenterValidatedByName: userName,
    financeStatus: inheritedFinanceStatus(row),
    approvedById: row.approvedById,
    approvedAt: row.approvedAt,
    approvedAccountName: row.approvedAccountName,
    approvedByName: row.approvedByName,
  };
};

/** Fase 9: as colunas de uma linha de arquivo que a nova versão leva (ou muda). */
export type InvoiceFileVersionRow = { id: string; kind: InvoiceFileKind } & Pick<
  RevalleInvoiceFile,
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

type InvoiceFileVersionColumns = Omit<InvoiceFileVersionRow, 'id' | 'kind'>;

/**
 * Só as colunas de versão, nomeadas uma a uma: quem chama passa a linha inteira do banco (com `envelopeId`, `order`,
 * `title`, datas…), e nada disso pode ir para a linha da nova versão.
 */
const versionColumns = (file: InvoiceFileVersionRow): InvoiceFileVersionColumns => ({
  choiceCode: file.choiceCode,
  choiceById: file.choiceById,
  choiceAt: file.choiceAt,
  acceptedSuggestion: file.acceptedSuggestion,
  costCenterCode: file.costCenterCode,
  costCenterById: file.costCenterById,
  costCenterAt: file.costCenterAt,
  costCenterValidatedAt: file.costCenterValidatedAt,
  costCenterValidatedById: file.costCenterValidatedById,
  costCenterValidatedByName: file.costCenterValidatedByName,
  approvedById: file.approvedById,
  approvedAt: file.approvedAt,
  approvedAccountName: file.approvedAccountName,
  approvedByName: file.approvedByName,
});

const NO_APPROVAL = {
  approvedById: null,
  approvedAt: null,
  approvedAccountName: null,
  approvedByName: null,
} satisfies Partial<InvoiceFileVersionColumns>;

/**
 * Fase 9: as linhas de arquivo da nova versão e a situação do envio, quando UMA nota muda (`targetFileId`).
 *
 * - Uma nota só: a regra das Fases 6/7 (`nextClassification`): a troca de conta sai aprovada por quem trocou; a correção
 *   do centro leva a aprovação da versão anterior.
 * - Duas ou mais notas ("Decidido em 16/11/2026"): a nota alvo recebe a mudança (conta escolhida por quem trocou, ou
 *   centro novo validado por quem corrigiu) e TODAS as notas ficam sem aprovação, aguardando o Financeiro; as contas, os
 *   centros e as validações das outras ficam como estão.
 *
 * Os arquivos que não são nota vão sem mudança. `acceptedSuggestion` da nota alvo fica como está (quem chama decide com a
 * sugestão ainda ativa na lista).
 */
export const nextInvoiceFiles = ({
  files,
  targetFileId,
  change,
  previousFinanceStatus,
  user,
  now,
  accountName,
}: {
  files: InvoiceFileVersionRow[];
  targetFileId: string;
  change: InvoiceVersionChange;
  previousFinanceStatus: RevalleInvoiceClassification['financeStatus'];
  user: { id: number; name: string | null };
  now: Date;
  accountName: string | null;
}): { financeStatus: 'APPROVED' | 'PENDING_APPROVAL'; files: Map<string, InvoiceFileVersionColumns> } => {
  const nfs = files.filter((file) => file.kind === 'NF');
  const target = nfs.find((file) => file.id === targetFileId);

  if (!target) {
    throw new Error('A nota que muda não é uma nota deste envio.');
  }

  if (nfs.length === 1) {
    const { financeStatus, ...next } = nextClassification(
      { ...target, financeStatus: previousFinanceStatus },
      change,
      user,
      now,
      accountName,
    );

    return {
      financeStatus,
      files: new Map(
        files.map((file) => [
          file.id,
          file.id === target.id ? { ...versionColumns(file), ...next } : versionColumns(file),
        ]),
      ),
    };
  }

  const userName = user.name?.trim() || null;
  const changed =
    change.kind === 'ACCOUNT'
      ? { choiceCode: change.code, choiceById: user.id, choiceAt: now }
      : {
          costCenterCode: change.code,
          costCenterById: user.id,
          costCenterAt: now,
          costCenterValidatedAt: now,
          costCenterValidatedById: user.id,
          costCenterValidatedByName: userName,
        };

  return {
    financeStatus: 'PENDING_APPROVAL',
    files: new Map(
      files.map((file) => [
        file.id,
        file.kind === 'NF'
          ? { ...versionColumns(file), ...(file.id === target.id ? changed : {}), ...NO_APPROVAL }
          : versionColumns(file),
      ]),
    ),
  };
};
