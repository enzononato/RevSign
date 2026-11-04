import type { RevalleInvoiceClassification } from '@prisma/client';

import { costCenterLabel } from '../invoice/cost-centers';

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

/** A frase do que mudou, igual para todos que recebem o aviso. `from` nulo: a versão trocada não tinha conta. */
export const versionChangeNoticeLine = (change: VersionChangeLine) => {
  if (change.kind === 'COST_CENTER') {
    return `O centro de custo foi corrigido de ${costCenterLabel(change.fromCode)} para ${costCenterLabel(change.toCode)}.`;
  }

  const account = change.from
    ? `alterada pelo Financeiro de ${change.from} para ${change.to}`
    : `definida pelo Financeiro: ${change.to}`;

  return `A conta contábil da nota fiscal ${change.title} foi ${account}.`;
};

/**
 * Texto exato do aviso de uma nova versão (e-mail para o remetente e os destinatários das duas versões). O ponto final
 * do modelo não é dobrado quando o motivo já termina com pontuação.
 */
export const buildVersionChangeNotice = (change: VersionChangeLine, reason: string) => {
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
