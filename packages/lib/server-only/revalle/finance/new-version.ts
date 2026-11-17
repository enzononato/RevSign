import { prisma } from '@documenso/prisma';
import type { EnvelopeAttachment, Recipient, RevalleInvoiceClassification, RevalleInvoiceFile } from '@prisma/client';
import {
  DocumentStatus,
  EnvelopeType,
  Prisma,
  RevalleFinanceStatus,
  RevalleInvoiceFileKind,
  RevalleInvoiceStatus,
  RevalleSuggestionStatus,
  SigningStatus,
} from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import {
  CHANGE_REASON_MESSAGE,
  type InvoiceVersionChange,
  isValidChangeReason,
  nextInvoiceFiles,
  nextVersionTitle,
} from '../../../revalle/finance/account-change';
import { isCostCenterCode } from '../../../revalle/invoice/cost-centers';
import { NO_INVOICE_DATA_COLUMNS } from '../../../revalle/invoice/invoice-data';
import { invoicePositions } from '../../../revalle/invoice/invoice-files';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import type { ApiRequestMetadata } from '../../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { logger } from '../../../utils/logger';
import { sendDocument } from '../../document/send-document';
import { duplicateEnvelope } from '../../envelope/duplicate-envelope';
import { revalleErrorCode } from '../error-code';
import { invoiceAuditDocument, invoiceFileSuggestion } from '../invoice/classify';
import type { InvoiceEnvelopeFile } from '../invoice/envelope-files';
import { filesKey, loadEnvelopeFiles } from '../invoice/envelope-files';
import type { LoadedInvoiceFile } from '../invoice/invoice-files';
import {
  ensureLegacyInvoiceFiles,
  loadInvoiceFiles,
  lockInvoiceEnvelope,
  resolveInvoiceFile,
  syncInvoiceEnvelopeMirror,
} from '../invoice/invoice-files';
import { releaseOwnLease } from './define-and-send';
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
 * novo. O que muda por tipo está em `nextInvoiceFiles` (`nextClassification` com uma nota); todo o resto é igual.
 *
 * Fase 9: a mudança é de UMA nota (`envelopeItemId`, obrigatório com 2+ notas). Com 2+ notas, a nova versão deixa todas
 * as notas aguardando o Financeiro (as contas, os centros e as validações das outras ficam), e a versão antiga guarda em
 * `supersededEnvelopeItemId` o arquivo da nota que mudou. A marca confere um retrato de todas as notas (conta, centro,
 * validação e aprovação de cada uma): uma aprovação ou validação de outra nota no meio faz este pedido recomeçar.
 *
 * 1. Marca a antiga `SUPERSEDED` (quem, quando, motivo, `supersedeKind`) numa gravação condicionada ao estado, à conta, ao
 *    centro e à validação lidos: de dois pedidos ao mesmo tempo, de um tipo ou de outro, só um vence; o outro recebe
 *    409/400 e nada cria.
 * 2. Cria a nova com o `duplicateEnvelope` do upstream, em nome do dono: mesmo arquivo ORIGINAL (`initialData`, nunca o
 *    selado), destinatários, papéis, ordem, campos e configurações.
 * 3. Numa transação: título "(vN)", classificação da nova (`nextInvoiceFiles`, `version` + 1, ligação), ligação na
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
  envelopeItemId,
  change,
  reason,
  user,
  requestMetadata,
}: {
  envelopeId: string;
  envelopeItemId?: string;
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

  // Fase 9: a nota que muda (a linha do arquivo); com 2+ notas, `envelopeItemId` diz qual.
  await ensureLegacyInvoiceFiles(envelopeId);

  const file = await resolveInvoiceFile({ envelopeId, envelopeItemId });
  const files = await loadInvoiceFiles(envelopeId);
  const snapshot = notesSnapshot(files);
  const isMulti = files.filter((other) => other.kind === RevalleInvoiceFileKind.NF).length > 1;
  const note = noteVersionRow(row, file);
  const account = await assertChangeAllowed({ row: note, change });

  if (envelope.user.disabled) {
    throw invalid(OWNER_UNAVAILABLE_MESSAGE);
  }

  const count = await prisma.$transaction(async (tx) => {
    // A trava do envio antes de tudo (com a selagem, que trava esta linha antes de concluir, a ordem fica definida).
    await lockInvoiceEnvelope(tx, envelopeId);

    // A conta, o centro, a validação e a aprovação de TODAS as notas também são lidos aqui: a nova versão copia o que a
    // antiga tem, e um primeiro centro escolhido, uma validação ou uma aprovação no meio (de qualquer nota) devem fazer
    // este pedido recomeçar.
    if (notesSnapshot(await loadInvoiceFiles(envelopeId, tx)) !== snapshot) {
      return 0;
    }

    const marked = await tx.revalleInvoiceClassification.updateMany({
      where: {
        envelopeId,
        isInvoice: RevalleInvoiceStatus.YES,
        // O estado exato que foi lido.
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
        // Fase 9: com 2+ notas, a nota que mudou (o /verificar e o aviso dizem qual).
        supersededEnvelopeItemId: isMulti ? file.envelopeItemId : null,
      },
    });

    return marked.count;
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
    previous: { envelopeId, envelope, row, file },
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
 * O retrato das notas do envio que a marca confere: por nota, a conta, o centro, a validação e a aprovação. Igual ao lido =
 * nada mudou no meio.
 */
const notesSnapshot = (files: LoadedInvoiceFile[]) =>
  files
    .filter((file) => file.kind === RevalleInvoiceFileKind.NF)
    .map((file) =>
      [
        file.id,
        file.choiceCode ?? '',
        file.costCenterCode ?? '',
        file.costCenterValidatedAt?.toISOString() ?? '',
        file.approvedAt?.toISOString() ?? '',
      ].join('|'),
    )
    .sort()
    .join('\n');

/** O que a nova versão lê da versão atual: a situação do envio e as colunas da nota (a linha do arquivo). */
type NoteVersionRow = Pick<RevalleInvoiceClassification, 'financeStatus' | 'supersededAt' | 'supersededByEnvelopeId'> &
  Pick<
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

const noteVersionRow = (row: RevalleInvoiceClassification, file: LoadedInvoiceFile): NoteVersionRow => ({
  financeStatus: row.financeStatus,
  supersededAt: row.supersededAt,
  supersededByEnvelopeId: row.supersededByEnvelopeId,
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

/**
 * O que é próprio de cada tipo antes da marca. A conta devolvida é a nova da troca (o nome dela fica congelado na
 * aprovação da nova versão); a correção do centro não lê conta nenhuma.
 */
const assertChangeAllowed = async ({ row, change }: { row: NoteVersionRow; change: InvoiceVersionChange }) => {
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
  /** Fase 9: a nota que muda. */
  file: LoadedInvoiceFile;
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
  const { envelopeId, envelope, row, file } = previous;
  const version = row.version + 1;
  const title = nextVersionTitle(envelope.title, version);
  // A chave dos arquivos da cópia, como a classificação calcula: no envio, o rascunho com a mesma chave mantém a conta.
  const newFiles = await loadEnvelopeFiles(newEnvelopeId);
  const fileSha256 = filesKey(newFiles);
  const suggestion = await invoiceFileSuggestion(file);
  const fromAccount = file.choiceCode;
  const fromName =
    change.kind === 'ACCOUNT' && fromAccount
      ? ((await prisma.revalleAccountingAccount.findUnique({ where: { code: fromAccount }, select: { name: true } }))
          ?.name ?? null)
      : null;
  // Fase 9: TODAS as linhas de arquivo vão para os arquivos da cópia (pela ordem, depois pelo título). A nota que muda
  // ganha a conta/o centro da nova versão; com 2+ notas, todas ficam sem aprovação (`nextInvoiceFiles`).
  const oldFiles = await loadInvoiceFiles(envelopeId);
  const next = nextInvoiceFiles({
    files: oldFiles,
    targetFileId: file.id,
    change,
    previousFinanceStatus: row.financeStatus,
    user,
    now,
    accountName,
  });
  const financeStatus = next.financeStatus;
  const pairs = pairCopiedFiles(oldFiles, newFiles);
  const positions = invoicePositions(oldFiles);
  const oldDocument = invoiceAuditDocument(file, positions);
  const copyOfTarget = pairs.find(([old]) => old.id === file.id)?.[1];
  const newDocument = copyOfTarget
    ? invoiceAuditDocument({ ...file, envelopeItemId: copyOfTarget.envelopeItemId }, positions)
    : {};
  const fileRows = pairs.map(([old, copy]) => ({
    ...copiedFileRow(old, copy, newEnvelopeId),
    ...next.files.get(old.id),
    ...(old.id === file.id
      ? {
          // Fica fora da função pura: depende da sugestão ainda ativa na lista, lida do banco.
          acceptedSuggestion:
            change.kind === 'ACCOUNT'
              ? suggestion
                ? suggestion.accountCode === change.code
                : null
              : file.acceptedSuggestion,
        }
      : {}),
  }));

  // O que é do envio. As colunas "da nota" (o espelho) vêm das linhas de arquivo (`syncInvoiceEnvelopeMirror`).
  const classification = {
    isInvoice: RevalleInvoiceStatus.YES,
    detectedBy: row.detectedBy,
    flagChangedById: row.flagChangedById,
    flagChangedAt: row.flagChangedAt,
    signals: row.signals,
    fileSha256,
    financeStatus,
    previousEnvelopeId: envelopeId,
    version,
  };

  await prisma.$transaction(async (tx) => {
    // A trava da versão atual antes de tudo (a mesma ordem da selagem e das gravações da nota).
    await lockInvoiceEnvelope(tx, envelopeId);

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

    // As linhas que uma classificação na hora possa ter criado dão lugar às copiadas.
    await tx.revalleInvoiceFile.deleteMany({ where: { envelopeId: newEnvelopeId } });
    await tx.revalleInvoiceFile.createMany({ data: fileRows });
    await syncInvoiceEnvelopeMirror(tx, newEnvelopeId);

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
      const link = {
        reason: supersedeReason,
        otherEnvelopeId,
        isNewVersion,
        ...(isNewVersion ? newDocument : oldDocument),
      };

      await tx.documentAuditLog.create({
        data:
          change.kind === 'COST_CENTER'
            ? createDocumentAuditLogData({
                ...base,
                type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_COST_CENTER_CHANGED,
                data: { fromCode: file.costCenterCode ?? '', toCode: change.code, ...link },
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
 * Fase 9: cada linha de arquivo da versão atual com o arquivo da cópia (`duplicateEnvelope` copia título e ordem): pela
 * ordem, e no empate pelo título. Contagem diferente (ou arquivo sem par) é erro, e a troca é desfeita.
 */
const pairCopiedFiles = (
  rows: LoadedInvoiceFile[],
  copies: InvoiceEnvelopeFile[],
): Array<[LoadedInvoiceFile, InvoiceEnvelopeFile]> => {
  if (rows.length !== copies.length) {
    throw new Error('A cópia não tem os mesmos arquivos da versão atual.');
  }

  const free = [...copies];

  return rows.map((row) => {
    const sameOrder = free.filter((copy) => copy.order === row.order);
    const match =
      (sameOrder.length === 1 ? sameOrder[0] : undefined) ??
      sameOrder.find((copy) => copy.title === row.title) ??
      free.find((copy) => copy.title === row.title);

    if (!match) {
      throw new Error('Um arquivo da versão atual não tem par na cópia.');
    }

    free.splice(free.indexOf(match), 1);

    return [row, match];
  });
};

const jsonOrDbNull = (value: unknown) => (value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue));

/**
 * A linha de um arquivo copiada para a nova versão: o mesmo arquivo, então o tipo, as chaves de acesso, o que a IA leu, a
 * conta, o centro, a validação e a aprovação vão juntos. Uma leitura em andamento não vai (fica SKIPPED, sem dados).
 */
const copiedFileRow = (old: LoadedInvoiceFile, copy: InvoiceEnvelopeFile, newEnvelopeId: string) => {
  const isSuggestionPending = old.suggestionStatus === RevalleSuggestionStatus.PENDING;

  return {
    envelopeId: newEnvelopeId,
    envelopeItemId: copy.envelopeItemId,
    kind: old.kind,
    detectedBy: old.detectedBy,
    kindChangedById: old.kindChangedById,
    kindChangedAt: old.kindChangedAt,
    signals: old.signals,
    fileSha256: copy.sha256,
    suggestionStatus: isSuggestionPending ? RevalleSuggestionStatus.SKIPPED : old.suggestionStatus,
    suggestion: isSuggestionPending ? Prisma.DbNull : jsonOrDbNull(old.suggestion),
    suggestionAttempts: old.suggestionAttempts,
    ...(isSuggestionPending
      ? NO_INVOICE_DATA_COLUMNS
      : { supplierName: old.supplierName, invoiceNumber: old.invoiceNumber, totalAmountCents: old.totalAmountCents }),
    accessKeys: old.accessKeys,
    boletoData: jsonOrDbNull(old.boletoData),
    choiceCode: old.choiceCode,
    choiceById: old.choiceById,
    choiceAt: old.choiceAt,
    acceptedSuggestion: old.acceptedSuggestion,
    costCenterCode: old.costCenterCode,
    costCenterById: old.costCenterById,
    costCenterAt: old.costCenterAt,
    costCenterValidatedAt: old.costCenterValidatedAt,
    costCenterValidatedById: old.costCenterValidatedById,
    costCenterValidatedByName: old.costCenterValidatedByName,
    approvedById: old.approvedById,
    approvedAt: old.approvedAt,
    approvedAccountName: old.approvedAccountName,
    approvedByName: old.approvedByName,
  };
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
        supersededEnvelopeItemId: row.supersededEnvelopeItemId,
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
      await releaseOwnLease(newEnvelopeId, now);
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
