import { prisma } from '@documenso/prisma';
import type { Recipient, RevalleInvoiceClassification } from '@prisma/client';
import {
  DocumentStatus,
  EnvelopeType,
  Prisma,
  RevalleFinanceStatus,
  RevalleInvoiceStatus,
  RevalleSuggestionStatus,
  SigningStatus,
} from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { jobs } from '../../../jobs/client';
import { isValidChangeReason, nextVersionTitle } from '../../../revalle/finance/account-change';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import type { ApiRequestMetadata } from '../../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { logger } from '../../../utils/logger';
import { sendDocument } from '../../document/send-document';
import { duplicateEnvelope } from '../../envelope/duplicate-envelope';
import { revalleErrorCode } from '../error-code';
import { toInvoiceState } from '../invoice/classify';
import { filesKey, loadEnvelopeFiles } from '../invoice/envelope-files';

export type ChangeInvoiceAccountResult = { newEnvelopeId: string };

/**
 * Uma troca que morreu no meio (queda do processo entre marcar a versão antiga e ligar a nova) deixa a antiga
 * `SUPERSEDED` sem sucessora. Passado esse prazo, outra troca a retoma; antes dele, 409 "em andamento".
 */
export const FINANCE_CHANGE_LEASE_MS = 5 * 60 * 1000;

const REASON_MESSAGE = 'Escreva o motivo da troca (de 10 a 500 caracteres).';
const NOT_CHANGEABLE_MESSAGE =
  'Só dá para trocar a conta de uma nota fiscal enviada (aguardando aprovação ou aprovada) ou concluída.';
const ALREADY_SUPERSEDED_MESSAGE = 'Esta versão da nota fiscal já foi substituída: troque a conta na versão nova.';
const DELETED_MESSAGE = 'Este documento foi excluído.';
const SAME_ACCOUNT_MESSAGE = 'Escolha uma conta diferente da atual.';
const INACTIVE_ACCOUNT_MESSAGE = 'Conta contábil inativa ou inexistente.';
const IN_PROGRESS_MESSAGE = 'A conta desta nota fiscal está sendo trocada agora. Atualize a página em instantes.';
const NOT_SENT_MESSAGE =
  'A conta foi trocada e a nova versão foi criada, mas o envio dela falhou. Corrija o problema e envie a nova versão em "Definir conta e enviar".';

const invalid = (message: string) => new AppError(AppErrorCode.INVALID_REQUEST, { message, userMessage: message });

const inProgressError = () =>
  new AppError('FINANCE_CHANGE_IN_PROGRESS', {
    message: IN_PROGRESS_MESSAGE,
    userMessage: IN_PROGRESS_MESSAGE,
    statusCode: 409,
  });

const CHANGEABLE: Partial<Record<DocumentStatus, RevalleFinanceStatus[]>> = {
  [DocumentStatus.PENDING]: [RevalleFinanceStatus.PENDING_APPROVAL, RevalleFinanceStatus.APPROVED],
  [DocumentStatus.COMPLETED]: [
    RevalleFinanceStatus.PENDING_APPROVAL,
    RevalleFinanceStatus.APPROVED,
    RevalleFinanceStatus.LEGACY,
  ],
};

const isStaleClaim = (row: RevalleInvoiceClassification, now: Date) =>
  row.financeStatus === RevalleFinanceStatus.SUPERSEDED &&
  row.supersededByEnvelopeId === null &&
  row.supersededAt !== null &&
  now.getTime() - row.supersededAt.getTime() >= FINANCE_CHANGE_LEASE_MS;

/**
 * "Trocar conta" (o membro do Financeiro já foi conferido pela rota): a versão atual da NF é substituída por uma NOVA
 * VERSÃO, com a conta nova já aprovada, que todos assinam de novo.
 *
 * 1. Marca a antiga `SUPERSEDED` (quem, quando, motivo) numa gravação condicionada ao estado e à conta lidos: de dois
 *    pedidos ao mesmo tempo, só um vence; o outro recebe 409/400 e nada cria.
 * 2. Cria a nova com o `duplicateEnvelope` do upstream, em nome do dono: mesmo arquivo ORIGINAL (`initialData`, nunca o
 *    selado), destinatários, papéis, ordem, campos e configurações.
 * 3. Numa transação: título "(vN)", classificação da nova (`APPROVED` por quem trocou, `version` + 1, ligação), ligação
 *    na antiga, a antiga pendente escondida das listas (sem os e-mails de cancelamento do upstream) e o evento
 *    `REVALLE_FINANCE_ACCOUNT_CHANGED` nas duas versões.
 *    Se 2 ou 3 falham, a marca de 1 é desfeita e a cópia apagada: a antiga nunca fica substituída sem sucessora.
 * 4. Depois: o aviso por e-mail e o envio da nova em nome do dono (já aprovada: não é retida nem vai ao Financeiro). Se
 *    o envio falhar com a nova ainda em rascunho, ela fica `APPROVED` com a reserva solta (`approvedAt` nulo) e o
 *    Financeiro envia depois com `defineAccount` (que retoma uma reserva solta na hora).
 */
export const changeInvoiceAccount = async ({
  envelopeId,
  code,
  reason,
  user,
  requestMetadata,
}: {
  envelopeId: string;
  code: string;
  reason: string;
  user: { id: number; name: string | null; email: string };
  requestMetadata: ApiRequestMetadata;
}): Promise<ChangeInvoiceAccountResult> => {
  const supersedeReason = reason.trim();

  if (!isValidChangeReason(supersedeReason)) {
    throw invalid(REASON_MESSAGE);
  }

  const envelope = await prisma.envelope.findUnique({
    where: { id: envelopeId },
    select: {
      type: true,
      title: true,
      status: true,
      deletedAt: true,
      userId: true,
      teamId: true,
      folderId: true,
      recipients: { select: { email: true, signingStatus: true, authOptions: true } },
      revalleInvoice: true,
    },
  });

  const row = envelope?.revalleInvoice;

  if (!envelope || envelope.type !== EnvelopeType.DOCUMENT || !row || row.isInvoice !== RevalleInvoiceStatus.YES) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Nota fiscal não encontrada.' });
  }

  const now = new Date();
  const isTakeover = isStaleClaim(row, now);

  if (row.financeStatus === RevalleFinanceStatus.SUPERSEDED && !isTakeover) {
    throw row.supersededByEnvelopeId ? invalid(ALREADY_SUPERSEDED_MESSAGE) : inProgressError();
  }

  if (envelope.deletedAt) {
    throw invalid(DELETED_MESSAGE);
  }

  const allowed = CHANGEABLE[envelope.status] ?? [];
  const isRejected = envelope.recipients.some((recipient) => recipient.signingStatus === SigningStatus.REJECTED);

  if (allowed.length === 0 || isRejected || (!isTakeover && !allowed.some((value) => value === row.financeStatus))) {
    throw invalid(NOT_CHANGEABLE_MESSAGE);
  }

  if (!row.choiceDefer && row.choiceCode === code) {
    throw invalid(SAME_ACCOUNT_MESSAGE);
  }

  const account = await prisma.revalleAccountingAccount.findUnique({
    where: { code },
    select: { code: true, name: true, active: true },
  });

  if (!account?.active) {
    throw invalid(INACTIVE_ACCOUNT_MESSAGE);
  }

  const { count } = await prisma.revalleInvoiceClassification.updateMany({
    where: {
      envelopeId,
      isInvoice: RevalleInvoiceStatus.YES,
      choiceCode: row.choiceCode,
      choiceDefer: row.choiceDefer,
      ...(isTakeover
        ? {
            financeStatus: RevalleFinanceStatus.SUPERSEDED,
            supersededAt: row.supersededAt,
            supersededByEnvelopeId: null,
          }
        : { financeStatus: { in: allowed }, supersededAt: null }),
    },
    data: {
      financeStatus: RevalleFinanceStatus.SUPERSEDED,
      supersededAt: now,
      supersededById: user.id,
      supersedeReason,
    },
  });

  if (count === 0) {
    const latest = await prisma.revalleInvoiceClassification.findUnique({
      where: { envelopeId },
      select: { financeStatus: true },
    });

    throw latest?.financeStatus === RevalleFinanceStatus.SUPERSEDED
      ? inProgressError()
      : invalid(NOT_CHANGEABLE_MESSAGE);
  }

  const { newEnvelopeId, title: newTitle } = await createNewVersionOrUndo({
    previous: { envelopeId, envelope, row },
    account,
    supersedeReason,
    user,
    now,
    requestMetadata,
  });

  try {
    await jobs.triggerJob({
      name: 'send.revalle.finance.account.changed.email',
      payload: { oldEnvelopeId: envelopeId, newEnvelopeId },
    });
  } catch {
    logger.warn({ msg: 'revalle finance: falha ao disparar o aviso da troca de conta', envelopeId, newEnvelopeId });
  }

  await sendNewVersion({ envelopeId, newEnvelopeId, newTitle, envelope, now, requestMetadata });

  return { newEnvelopeId };
};

type PreviousVersion = {
  envelopeId: string;
  envelope: {
    title: string;
    userId: number;
    teamId: number;
    folderId: string | null;
    recipients: Pick<Recipient, 'email' | 'authOptions'>[];
  };
  row: RevalleInvoiceClassification;
};

type NewVersionOptions = {
  previous: PreviousVersion;
  account: { code: string; name: string };
  supersedeReason: string;
  user: { id: number; name: string | null; email: string };
  now: Date;
  requestMetadata: ApiRequestMetadata;
};

/** Passos 2 e 3; se um deles falha, a marca da antiga é desfeita e a cópia apagada antes de repassar o erro. */
const createNewVersionOrUndo = async (options: NewVersionOptions) => {
  const { envelopeId, envelope, row } = options.previous;
  let newEnvelopeId: string | null = null;

  try {
    const duplicated = await duplicateEnvelope({
      id: { type: 'envelopeId', id: envelopeId },
      userId: envelope.userId,
      teamId: envelope.teamId,
      overrides: { includeRecipients: true, includeFields: true },
    });

    newEnvelopeId = duplicated.id;

    const { title } = await createNewVersion({ ...options, newEnvelopeId: duplicated.id });

    return { newEnvelopeId: duplicated.id, title };
  } catch (error) {
    await undoSupersede({ envelopeId, row, now: options.now, newEnvelopeId });

    throw error;
  }
};

const createNewVersion = async ({
  previous,
  newEnvelopeId,
  account,
  supersedeReason,
  user,
  now,
  requestMetadata,
}: NewVersionOptions & { newEnvelopeId: string }) => {
  const { envelopeId, envelope, row } = previous;
  const version = row.version + 1;
  const title = nextVersionTitle(envelope.title, version);
  // A chave dos arquivos da cópia, como a classificação calcula: no envio, o rascunho com a mesma chave mantém a conta.
  const fileSha256 = filesKey(await loadEnvelopeFiles(newEnvelopeId));
  const { suggestion } = await toInvoiceState(row);
  const fromAccount = row.choiceCode && !row.choiceDefer ? row.choiceCode : null;
  const fromName = fromAccount
    ? ((await prisma.revalleAccountingAccount.findUnique({ where: { code: fromAccount }, select: { name: true } }))
        ?.name ?? null)
    : null;
  const isSuggestionPending = row.suggestionStatus === RevalleSuggestionStatus.PENDING;

  const classification = {
    isInvoice: RevalleInvoiceStatus.YES,
    detectedBy: row.detectedBy,
    flagChangedById: row.flagChangedById,
    flagChangedAt: row.flagChangedAt,
    signals: row.signals,
    fileSha256,
    suggestionStatus: isSuggestionPending ? RevalleSuggestionStatus.SKIPPED : row.suggestionStatus,
    suggestion: isSuggestionPending || row.suggestion === null ? Prisma.DbNull : row.suggestion,
    suggestionAttempts: row.suggestionAttempts,
    choiceCode: account.code,
    choiceDefer: false,
    choiceById: user.id,
    choiceAt: now,
    acceptedSuggestion: suggestion ? suggestion.accountCode === account.code : null,
    financeStatus: RevalleFinanceStatus.APPROVED,
    approvedById: user.id,
    approvedAt: now,
    previousEnvelopeId: envelopeId,
    version,
  };

  const changeData = {
    fromCode: fromAccount,
    fromName,
    toCode: account.code,
    toName: account.name,
    reason: supersedeReason,
  };

  await prisma.$transaction(async (tx) => {
    await tx.envelope.update({ where: { id: newEnvelopeId }, data: { title, folderId: envelope.folderId } });

    // O `duplicateEnvelope` do upstream não copia a autenticação de cada destinatário.
    for (const recipient of envelope.recipients) {
      if (recipient.authOptions !== null) {
        await tx.recipient.updateMany({
          where: { envelopeId: newEnvelopeId, email: recipient.email },
          data: { authOptions: recipient.authOptions },
        });
      }
    }

    // `upsert`: quem abrir o rascunho da cópia neste instante pode ter criado a linha (classificação na hora).
    await tx.revalleInvoiceClassification.upsert({
      where: { envelopeId: newEnvelopeId },
      create: { envelopeId: newEnvelopeId, ...classification },
      update: classification,
    });

    const linked = await tx.revalleInvoiceClassification.updateMany({
      where: {
        envelopeId,
        financeStatus: RevalleFinanceStatus.SUPERSEDED,
        supersededAt: now,
        supersededByEnvelopeId: null,
      },
      data: { supersededByEnvelopeId: newEnvelopeId },
    });

    if (linked.count === 0) {
      throw new Error('A marca da versão substituída mudou durante a troca.');
    }

    // A antiga pendente some das listas como um documento excluído, mas sem o e-mail de cancelamento (o aviso da troca
    // já explica) e sem prazo de expiração (o aviso de destinatário expirado não cabe numa versão substituída).
    const hidden = await tx.envelope.updateMany({
      where: { id: envelopeId, status: DocumentStatus.PENDING, deletedAt: null },
      data: { deletedAt: now },
    });

    if (hidden.count > 0) {
      await tx.recipient.updateMany({
        where: { envelopeId, documentDeletedAt: null },
        data: { documentDeletedAt: now },
      });

      await tx.recipient.updateMany({
        where: { envelopeId, signingStatus: SigningStatus.NOT_SIGNED, expiresAt: { not: null } },
        data: { expiresAt: null },
      });
    }

    for (const [target, otherEnvelopeId, isNewVersion] of [
      [envelopeId, newEnvelopeId, false],
      [newEnvelopeId, envelopeId, true],
    ] as const) {
      await tx.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_FINANCE_ACCOUNT_CHANGED,
          envelopeId: target,
          data: { ...changeData, otherEnvelopeId, isNewVersion },
          user,
          requestMetadata: requestMetadata.requestMetadata,
        }),
      });
    }
  });

  return { title };
};

/**
 * Desfaz a marca desta troca (condicionada à própria `supersededAt`): a versão volta ao estado lido, inclusive uma
 * troca retomada, que volta a ser a marca antiga. A cópia (ainda rascunho) é apagada; destinatários, campos e itens vão
 * junto (cascade).
 */
const undoSupersede = async ({
  envelopeId,
  row,
  now,
  newEnvelopeId,
}: {
  envelopeId: string;
  row: RevalleInvoiceClassification;
  now: Date;
  newEnvelopeId: string | null;
}) => {
  try {
    if (newEnvelopeId) {
      await prisma.envelope.deleteMany({ where: { id: newEnvelopeId, status: DocumentStatus.DRAFT } });
    }

    await prisma.revalleInvoiceClassification.updateMany({
      where: {
        envelopeId,
        financeStatus: RevalleFinanceStatus.SUPERSEDED,
        supersededAt: now,
        supersededByEnvelopeId: null,
      },
      data: {
        financeStatus: row.financeStatus,
        supersededAt: row.supersededAt,
        supersededById: row.supersededById,
        supersedeReason: row.supersedeReason,
      },
    });
  } catch (error) {
    // Sem desfazer, a versão fica marcada sem sucessora: outra troca a retoma depois do prazo.
    logger.error({
      msg: 'revalle finance: falha ao desfazer a troca de conta',
      envelopeId,
      newEnvelopeId,
      error: revalleErrorCode(error),
    });
  }
};

const sendNewVersion = async ({
  envelopeId,
  newEnvelopeId,
  newTitle,
  envelope,
  now,
  requestMetadata,
}: {
  envelopeId: string;
  newEnvelopeId: string;
  newTitle: string;
  envelope: { userId: number; teamId: number };
  now: Date;
  requestMetadata: ApiRequestMetadata;
}) => {
  try {
    await sendDocument({
      id: { type: 'envelopeId', id: newEnvelopeId },
      userId: envelope.userId,
      teamId: envelope.teamId,
      requestMetadata,
    });
  } catch (error) {
    const current = await prisma.envelope.findUnique({ where: { id: newEnvelopeId }, select: { status: true } });

    if (current?.status !== DocumentStatus.DRAFT) {
      // Já saiu (o erro veio depois da distribuição, ex.: um webhook): a nova versão vale.
      logger.warn({ msg: 'revalle finance: erro depois do envio da nova versão', envelopeId, newEnvelopeId });

      return;
    }

    // Solta a própria reserva: `defineAccount` reenvia na hora, sem esperar o prazo da reserva.
    await prisma.revalleInvoiceClassification.updateMany({
      where: { envelopeId: newEnvelopeId, financeStatus: RevalleFinanceStatus.APPROVED, approvedAt: now },
      data: { approvedAt: null },
    });

    logger.error({
      msg: 'revalle finance: nova versão criada e não enviada',
      envelopeId,
      newEnvelopeId,
      error: revalleErrorCode(error),
    });

    const cause = AppError.parseError(error);
    const message = `${NOT_SENT_MESSAGE} Nova versão: ${newTitle}. Erro: ${cause.userMessage ?? cause.message}`;

    throw new AppError('FINANCE_NEW_VERSION_NOT_SENT', { message, userMessage: message, statusCode: 409 });
  }
};
