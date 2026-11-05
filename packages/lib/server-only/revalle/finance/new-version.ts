import { prisma } from '@documenso/prisma';
import type { EnvelopeAttachment, Recipient, RevalleInvoiceClassification } from '@prisma/client';
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
import {
  CHANGE_REASON_MESSAGE,
  type InvoiceVersionChange,
  isValidChangeReason,
  nextClassification,
  nextVersionTitle,
} from '../../../revalle/finance/account-change';
import { isCostCenterCode } from '../../../revalle/invoice/cost-centers';
import { NO_INVOICE_DATA_COLUMNS } from '../../../revalle/invoice/invoice-data';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import type { ApiRequestMetadata } from '../../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { logger } from '../../../utils/logger';
import { sendDocument } from '../../document/send-document';
import { duplicateEnvelope } from '../../envelope/duplicate-envelope';
import { revalleErrorCode } from '../error-code';
import { toInvoiceState } from '../invoice/classify';
import { filesKey, loadEnvelopeFiles } from '../invoice/envelope-files';
import { isStaleChangeClaim } from './successor';

export type { InvoiceVersionChange };

export type CreateInvoiceNewVersionResult = { newEnvelopeId: string };

type ChangeUser = { id: number; name: string | null; email: string };

// `createdAt` do envelope vem do relógio do banco; a tentativa começa no relógio do app.
const ORPHAN_CLOCK_MARGIN_MS = 1000;

const DELETED_MESSAGE = 'Este documento foi excluído.';
const INACTIVE_ACCOUNT_MESSAGE = 'Conta contábil inativa ou inexistente.';
const UNKNOWN_COST_CENTER_MESSAGE = 'Centro de custo inexistente.';
const NO_COST_CENTER_MESSAGE = 'Esta nota fiscal ainda não tem centro de custo.';
const STATE_CHANGED_MESSAGE = 'A situação desta nota mudou. Atualize a página e tente de novo.';
const OWNER_UNAVAILABLE_MESSAGE =
  'O dono do documento está desativado ou não tem mais acesso a ele: a nova versão não pode ser criada em nome dele.';

const MESSAGES: Record<
  InvoiceVersionChange['kind'],
  {
    notChangeable: string;
    alreadySuperseded: string;
    same: string;
    inProgress: string;
    notSent: (title: string, cause: string) => string;
  }
> = {
  ACCOUNT: {
    notChangeable:
      'Só dá para trocar a conta de uma nota fiscal enviada (aguardando aprovação ou aprovada) ou concluída.',
    alreadySuperseded: 'Esta versão da nota fiscal já foi substituída: troque a conta na versão nova.',
    same: 'Escolha uma conta diferente da atual.',
    inProgress: 'A conta desta nota fiscal está sendo trocada agora. Atualize a página em instantes.',
    notSent: (title, cause) =>
      `A conta foi trocada e a nova versão "${title}" foi criada, mas não foi enviada: ${cause}. O remetente pode corrigir o rascunho e enviá-lo, ou o Financeiro envia de novo (mesma conta) depois da correção.`,
  },
  COST_CENTER: {
    notChangeable:
      'Só dá para corrigir o centro de custo de uma nota fiscal enviada (aguardando aprovação ou aprovada) ou concluída.',
    alreadySuperseded: 'Esta versão da nota fiscal já foi substituída: corrija o centro de custo na versão nova.',
    same: 'Escolha um centro de custo diferente do atual.',
    inProgress: 'O centro de custo desta nota fiscal está sendo corrigido agora. Atualize a página em instantes.',
    notSent: (title, cause) =>
      `O centro de custo foi corrigido e a nova versão "${title}" foi criada, mas não foi enviada: ${cause}. O remetente pode corrigir o rascunho e enviá-lo, ou a Contabilidade envia de novo (mesmo centro) depois da correção.`,
  },
};

const invalid = (message: string) => new AppError(AppErrorCode.INVALID_REQUEST, { message, userMessage: message });

const inProgressError = (kind: InvoiceVersionChange['kind']) =>
  new AppError('FINANCE_CHANGE_IN_PROGRESS', {
    message: MESSAGES[kind].inProgress,
    userMessage: MESSAGES[kind].inProgress,
    statusCode: 409,
  });

/**
 * Marca de outro pedido, ainda sem sucessora. Do mesmo tipo é um pedido repetido em andamento (409, tentar de novo em
 * instantes); do outro tipo, Financeiro e Contabilidade agindo ao mesmo tempo: quem perdeu recebe "A situação mudou".
 */
const claimedError = (
  claim: Pick<RevalleInvoiceClassification, 'supersedeKind'> | null | undefined,
  kind: InvoiceVersionChange['kind'],
) => (claim?.supersedeKind && claim.supersedeKind !== kind ? invalid(STATE_CHANGED_MESSAGE) : inProgressError(kind));

const CHANGEABLE: Partial<Record<DocumentStatus, RevalleFinanceStatus[]>> = {
  [DocumentStatus.PENDING]: [RevalleFinanceStatus.PENDING_APPROVAL, RevalleFinanceStatus.APPROVED],
  [DocumentStatus.COMPLETED]: [
    RevalleFinanceStatus.PENDING_APPROVAL,
    RevalleFinanceStatus.APPROVED,
    RevalleFinanceStatus.LEGACY,
  ],
};

/**
 * O motor único de nova versão, para a troca de conta pelo Financeiro e a correção do centro de custo pela Contabilidade
 * (o perfil já foi conferido pela rota): a versão atual da NF é substituída por uma NOVA VERSÃO, que todos assinam de
 * novo. O que muda por tipo está em `nextClassification`; todo o resto é igual.
 *
 * 1. Marca a antiga `SUPERSEDED` (quem, quando, motivo, `supersedeKind`) numa gravação condicionada ao estado, à conta, ao
 *    centro e à validação lidos: de dois pedidos ao mesmo tempo, de um tipo ou de outro, só um vence; o outro recebe
 *    409/400 e nada cria.
 * 2. Cria a nova com o `duplicateEnvelope` do upstream, em nome do dono: mesmo arquivo ORIGINAL (`initialData`, nunca o
 *    selado), destinatários, papéis, ordem, campos e configurações.
 * 3. Numa transação: título "(vN)", classificação da nova (`nextClassification`, `version` + 1, ligação), ligação na
 *    antiga, a antiga pendente escondida das listas (sem os e-mails de cancelamento do upstream) e o evento do tipo
 *    (`REVALLE_FINANCE_ACCOUNT_CHANGED` ou `REVALLE_COST_CENTER_CHANGED`) nas duas versões.
 *    Se 2 ou 3 falham, a marca de 1 é desfeita e a cópia apagada: a antiga nunca fica substituída sem sucessora.
 * 4. Depois: o envio da nova em nome do dono (aprovada, sela quando todos assinam; aguardando aprovação, a selagem espera
 *    o Financeiro); o aviso por e-mail sai junto com esse envio, com o link de assinatura da nova versão. Se o envio
 *    falhar com a nova ainda em rascunho:
 *    - `ACCOUNT`: ela fica `APPROVED` com a reserva solta (`approvedAt` nulo, era a da própria troca) e o Financeiro envia
 *      depois com `resendVersion` (que retoma uma reserva solta na hora), ou o remetente envia o rascunho;
 *    - `COST_CENTER`: a aprovação copiada não é reserva e não é tocada; ela fica como foi criada e o Financeiro, a
 *      Contabilidade ou o remetente a envia depois.
 *    O aviso sai nesse envio.
 */
export const createInvoiceNewVersion = async ({
  envelopeId,
  change,
  reason,
  user,
  requestMetadata,
}: {
  envelopeId: string;
  change: InvoiceVersionChange;
  reason: string;
  user: ChangeUser;
  requestMetadata: ApiRequestMetadata;
}): Promise<CreateInvoiceNewVersionResult> => {
  const supersedeReason = reason.trim();
  const messages = MESSAGES[change.kind];

  if (!isValidChangeReason(supersedeReason)) {
    throw invalid(CHANGE_REASON_MESSAGE);
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
      externalId: true,
      user: { select: { disabled: true } },
      envelopeAttachments: { select: { type: true, label: true, data: true } },
      recipients: { select: { email: true, signingStatus: true, authOptions: true } },
      revalleInvoice: true,
    },
  });

  const row = envelope?.revalleInvoice;

  if (!envelope || envelope.type !== EnvelopeType.DOCUMENT || !row || row.isInvoice !== RevalleInvoiceStatus.YES) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Nota fiscal não encontrada.' });
  }

  const now = new Date();
  const isTakeover = await isStaleChangeClaim(row, now);

  if (row.financeStatus === RevalleFinanceStatus.SUPERSEDED && !isTakeover) {
    throw row.supersededByEnvelopeId ? invalid(messages.alreadySuperseded) : claimedError(row, change.kind);
  }

  // Na retomada, a versão pendente já foi escondida (excluída) pela troca anterior.
  if (envelope.deletedAt && !isTakeover) {
    throw invalid(DELETED_MESSAGE);
  }

  const allowed = CHANGEABLE[envelope.status] ?? [];
  const isRejected = envelope.recipients.some((recipient) => recipient.signingStatus === SigningStatus.REJECTED);

  if (allowed.length === 0 || isRejected || (!isTakeover && !allowed.some((value) => value === row.financeStatus))) {
    throw invalid(messages.notChangeable);
  }

  const account = await assertChangeAllowed({ row, change });

  if (envelope.user.disabled) {
    throw invalid(OWNER_UNAVAILABLE_MESSAGE);
  }

  const { count } = await prisma.revalleInvoiceClassification.updateMany({
    where: {
      envelopeId,
      isInvoice: RevalleInvoiceStatus.YES,
      choiceCode: row.choiceCode,
      // O centro e a validação também são lidos aqui: a nova versão copia o que a antiga tem, e um primeiro centro
      // escolhido ou uma validação no meio devem fazer este pedido recomeçar.
      costCenterCode: row.costCenterCode,
      costCenterValidatedAt: row.costCenterValidatedAt,
      // O estado exato que foi lido (com a selagem, que trava esta linha antes de concluir, a ordem fica definida).
      financeStatus: row.financeStatus,
      supersededAt: row.supersededAt,
      supersededByEnvelopeId: row.supersededByEnvelopeId,
    },
    data: {
      financeStatus: RevalleFinanceStatus.SUPERSEDED,
      supersededAt: now,
      supersededById: user.id,
      supersedeReason,
      supersedeKind: change.kind,
      supersededByEnvelopeId: null,
    },
  });

  if (count === 0) {
    const latest = await prisma.revalleInvoiceClassification.findUnique({
      where: { envelopeId },
      select: { financeStatus: true, supersedeKind: true },
    });

    // Outro pedido mudou a NF entre a leitura e a marca (ex.: "Aprovar conta" ao mesmo tempo): tentar de novo funciona.
    throw latest?.financeStatus === RevalleFinanceStatus.SUPERSEDED
      ? claimedError(latest, change.kind)
      : invalid(STATE_CHANGED_MESSAGE);
  }

  const { newEnvelopeId, title: newTitle } = await createNewVersionOrUndo({
    previous: { envelopeId, envelope, row },
    change,
    accountName: account?.name ?? null,
    supersedeReason,
    user,
    now,
    requestMetadata,
  });

  // O aviso sai do envio da nova versão (`sendDocument`), agora ou quando o rascunho for enviado depois.
  await sendNewVersion({ envelopeId, newEnvelopeId, newTitle, envelope, change, now, requestMetadata });

  return { newEnvelopeId };
};

/**
 * O que é próprio de cada tipo antes da marca. A conta devolvida é a nova da troca (o nome dela fica congelado na
 * aprovação da nova versão); a correção do centro não lê conta nenhuma.
 */
const assertChangeAllowed = async ({
  row,
  change,
}: {
  row: RevalleInvoiceClassification;
  change: InvoiceVersionChange;
}) => {
  if (change.kind === 'COST_CENTER') {
    // Sem centro não há o que corrigir: o primeiro centro não gera nova versão (`defineInvoiceCostCenter`).
    if (!row.costCenterCode) {
      throw invalid(NO_COST_CENTER_MESSAGE);
    }

    if (row.costCenterCode === change.code) {
      throw invalid(MESSAGES.COST_CENTER.same);
    }

    if (!isCostCenterCode(change.code)) {
      throw invalid(UNKNOWN_COST_CENTER_MESSAGE);
    }

    return null;
  }

  if (row.choiceCode === change.code) {
    throw invalid(MESSAGES.ACCOUNT.same);
  }

  const account = await prisma.revalleAccountingAccount.findUnique({
    where: { code: change.code },
    select: { name: true, active: true },
  });

  if (!account?.active) {
    throw invalid(INACTIVE_ACCOUNT_MESSAGE);
  }

  return account;
};

type PreviousVersion = {
  envelopeId: string;
  envelope: {
    title: string;
    userId: number;
    teamId: number;
    folderId: string | null;
    externalId: string | null;
    envelopeAttachments: Pick<EnvelopeAttachment, 'type' | 'label' | 'data'>[];
    recipients: Pick<Recipient, 'email' | 'authOptions'>[];
  };
  row: RevalleInvoiceClassification;
};

type NewVersionOptions = {
  previous: PreviousVersion;
  change: InvoiceVersionChange;
  accountName: string | null;
  supersedeReason: string;
  user: ChangeUser;
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
    await undoSupersede({ envelopeId, envelope, row, now: options.now, newEnvelopeId });

    // `duplicateEnvelope` procura o documento pelo acesso do dono: sem acesso (saiu do time), "Document not found".
    if (newEnvelopeId === null && AppError.parseError(error).code === AppErrorCode.NOT_FOUND) {
      throw invalid(OWNER_UNAVAILABLE_MESSAGE);
    }

    throw error;
  }
};

const createNewVersion = async ({
  previous,
  newEnvelopeId,
  change,
  accountName,
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
  const fromAccount = row.choiceCode;
  const fromName =
    change.kind === 'ACCOUNT' && fromAccount
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
    // Fase 8: a cópia tem os mesmos arquivos, então leva o que a IA leu da NF (sem sugestão, sem dados).
    ...(isSuggestionPending
      ? NO_INVOICE_DATA_COLUMNS
      : {
          supplierName: row.supplierName,
          invoiceNumber: row.invoiceNumber,
          totalAmountCents: row.totalAmountCents,
        }),
    ...nextClassification(row, change, user, now, accountName),
    // Fica fora da função pura: depende da sugestão ainda ativa na lista, lida do banco.
    acceptedSuggestion:
      change.kind === 'ACCOUNT' ? (suggestion ? suggestion.accountCode === change.code : null) : row.acceptedSuggestion,
    previousEnvelopeId: envelopeId,
    version,
  };

  await prisma.$transaction(async (tx) => {
    await tx.envelope.update({
      where: { id: newEnvelopeId },
      data: { title, folderId: envelope.folderId, externalId: envelope.externalId },
    });

    // Anexos do envelope (links/arquivos de apoio): o `duplicateEnvelope` do upstream não copia.
    if (envelope.envelopeAttachments.length > 0) {
      await tx.envelopeAttachment.createMany({
        data: envelope.envelopeAttachments.map((attachment) => ({ ...attachment, envelopeId: newEnvelopeId })),
      });
    }

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

    // A antiga pendente some das listas como um documento excluído, mas sem o e-mail de cancelamento (o aviso já
    // explica) e sem prazo de expiração (o aviso de destinatário expirado não cabe numa versão substituída).
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
      const base = { envelopeId: target, user, requestMetadata: requestMetadata.requestMetadata };
      const link = { reason: supersedeReason, otherEnvelopeId, isNewVersion };

      await tx.documentAuditLog.create({
        data:
          change.kind === 'COST_CENTER'
            ? createDocumentAuditLogData({
                ...base,
                type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_COST_CENTER_CHANGED,
                data: { fromCode: row.costCenterCode ?? '', toCode: change.code, ...link },
              })
            : createDocumentAuditLogData({
                ...base,
                type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_FINANCE_ACCOUNT_CHANGED,
                data: { fromCode: fromAccount, fromName, toCode: change.code, toName: accountName, ...link },
              }),
      });
    }
  });

  return { title };
};

/**
 * Desfaz a marca deste pedido (condicionada à própria `supersededAt`): a versão volta ao estado lido, inclusive uma
 * troca retomada, que volta a ser a marca antiga. A cópia (ainda rascunho) é apagada; destinatários, campos e itens vão
 * junto (cascade).
 */
const undoSupersede = async ({
  envelopeId,
  envelope,
  row,
  now,
  newEnvelopeId,
}: {
  envelopeId: string;
  envelope: Pick<PreviousVersion['envelope'], 'title' | 'userId' | 'teamId'>;
  row: RevalleInvoiceClassification;
  now: Date;
  newEnvelopeId: string | null;
}) => {
  try {
    if (newEnvelopeId) {
      await prisma.envelope.deleteMany({ where: { id: newEnvelopeId, status: DocumentStatus.DRAFT } });
    } else {
      // `duplicateEnvelope` pode falhar depois de criar o envelope, sem devolver o id: a cópia dele tem o título
      // "{título} (copy)", é rascunho do dono, foi criada nesta tentativa e não tem classificação.
      await prisma.envelope.deleteMany({
        where: {
          userId: envelope.userId,
          teamId: envelope.teamId,
          title: `${envelope.title} (copy)`,
          status: DocumentStatus.DRAFT,
          createdAt: { gte: new Date(now.getTime() - ORPHAN_CLOCK_MARGIN_MS) },
          revalleInvoice: { is: null },
        },
      });
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
        supersedeKind: row.supersedeKind,
        supersededByEnvelopeId: row.supersededByEnvelopeId,
      },
    });
  } catch (error) {
    // Sem desfazer, a versão fica marcada sem sucessora: outro pedido a retoma depois do prazo.
    logger.error({
      msg: 'revalle finance: falha ao desfazer a nova versão',
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
  change,
  now,
  requestMetadata,
}: {
  envelopeId: string;
  newEnvelopeId: string;
  newTitle: string;
  envelope: { userId: number; teamId: number };
  change: InvoiceVersionChange;
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

    // Solta a própria reserva: `resendVersion` reenvia na hora, sem esperar o prazo da reserva. Só na troca de conta, em
    // que `approvedAt` é o desta troca; na correção do centro, ela é a aprovação copiada da versão anterior.
    if (change.kind === 'ACCOUNT') {
      await prisma.revalleInvoiceClassification.updateMany({
        where: { envelopeId: newEnvelopeId, financeStatus: RevalleFinanceStatus.APPROVED, approvedAt: now },
        data: { approvedAt: null },
      });
    }

    logger.error({
      msg: 'revalle finance: nova versão criada e não enviada',
      envelopeId,
      newEnvelopeId,
      error: revalleErrorCode(error),
    });

    const parsed = AppError.parseError(error);
    const cause = (parsed.userMessage || parsed.message || parsed.code).trim().replace(/[.!?…]+$/, '');
    const message = MESSAGES[change.kind].notSent(newTitle, cause);

    throw new AppError('FINANCE_NEW_VERSION_NOT_SENT', { message, userMessage: message, statusCode: 409 });
  }
};
