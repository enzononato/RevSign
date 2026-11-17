import { prisma } from '@documenso/prisma';
import { RevalleFinanceStatus, RevalleInvoiceFileKind, RevalleInvoiceStatus } from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { isCostCenterCode } from '../../../revalle/invoice/cost-centers';
import { invoicePositions } from '../../../revalle/invoice/invoice-files';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import type { RequestMetadata } from '../../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { isAdmin } from '../../../utils/is-admin';
import { loadActionableInvoice } from '../accounting/validate-cost-center';
import type { InvoiceState } from './classify';
import {
  classifyEnvelope,
  financeDecidesError,
  getInvoiceState,
  invoiceAuditDocument,
  invoiceFileSuggestion,
  isDraftFinanceStatusLocked,
  isEnvelopeDraft,
} from './classify';
import { assertInvoiceRecipientEmails } from './external-recipients';
import type { LoadedInvoiceFile } from './invoice-files';
import {
  ensureLegacyInvoiceFiles,
  loadInvoiceFiles,
  lockInvoiceEnvelope,
  resolveInvoiceFile,
  syncInvoiceEnvelopeMirror,
} from './invoice-files';

export const INVOICE_ACCOUNT_REQUIRED_MESSAGE = 'Escolha a conta contábil e o centro de custo.';

/** Modelo e envio em lote: o documento é criado, mas o envio da nota fiscal espera a conta e o centro de custo. */
export const INVOICE_DRAFT_CREATED_MESSAGE =
  'O documento foi criado como rascunho, mas é uma nota fiscal: abra o rascunho, escolha a conta contábil e o centro de custo e envie.';

/** Depois do envio, o centro já escolhido só muda pela Contabilidade; por esta rota ninguém o troca. */
const INVOICE_COST_CENTER_AFTER_SEND_MESSAGE = 'Depois do envio, quem corrige o centro de custo é a Contabilidade.';

/** Nova versão com o envio parado: o centro só muda por uma nova correção da Contabilidade, depois do envio. */
const INVOICE_COST_CENTER_LOCKED_MESSAGE =
  'Esta nova versão já tem o centro de custo definido: depois do envio, quem corrige é a Contabilidade.';

const INVOICE_SUPERSEDED_MESSAGE = 'Esta versão da nota fiscal já foi substituída: a nova versão é que vale.';

const supersededError = () =>
  new AppError(AppErrorCode.FORBIDDEN, {
    message: INVOICE_SUPERSEDED_MESSAGE,
    userMessage: INVOICE_SUPERSEDED_MESSAGE,
  });

export type InvoiceChoice = { code: string };

/** Fase 9: com 2+ notas, a mensagem diz em quais falta (`Falta em: nf-c.pdf.`). */
const invoiceChoiceRequiredError = (missingTitles: string[] = []) => {
  const message =
    missingTitles.length > 0
      ? `${INVOICE_ACCOUNT_REQUIRED_MESSAGE} Falta em: ${missingTitles.join(', ')}.`
      : INVOICE_ACCOUNT_REQUIRED_MESSAGE;

  return new AppError('INVOICE_ACCOUNT_REQUIRED', { message, userMessage: message, statusCode: 400 });
};

/**
 * Conferência do envio (`sendDocument`), só no primeiro envio (rascunho). Classifica na hora se ainda não foi
 * (cliente da API que envia logo depois de criar): só a detecção, sem esperar a IA. NF sem escolha → recusa.
 * Devolve o que o envio faz com a NF (Fase 6): `APPROVAL` = NF com conta (sai e aguarda a aprovação); `NONE` = não é NF.
 *
 * Fase 7: o primeiro envio da NF exige a conta (ainda ativa na lista) E o centro de custo. A nova versão
 * (`previousEnvelopeId`) herda o que a anterior tinha: uma NF que foi enviada sem centro ou sem conta continua podendo ser
 * enviada de novo nela, e o que o Financeiro ou a Contabilidade acabou de escolher vale. Se o arquivo do rascunho foi
 * trocado, a situação é zerada e a isenção acaba: é um primeiro envio como outro qualquer.
 *
 * E-mail externo (16/11/2026): NF com destinatário de fora da empresa é recusada (`INVOICE_EXTERNAL_RECIPIENT`).
 */
export const assertInvoiceChoiceBeforeSend = async (
  envelopeId: string,
  recipientEmails: Array<string | null | undefined> = [],
): Promise<'APPROVAL' | 'NONE'> => {
  const state = await classifyEnvelope(envelopeId, {}, { startSuggestion: false });

  if (state.isInvoice !== 'YES') {
    return 'NONE';
  }

  // E-mail externo: NF só vai para e-mails da empresa, também na nova versão do Financeiro. Antes da conta: trocar o
  // e-mail é o que destrava, e a conta escolhida não muda nada.
  assertInvoiceRecipientEmails(recipientEmails);

  const row = await prisma.revalleInvoiceClassification.findUnique({
    where: { envelopeId },
    select: { previousEnvelopeId: true, financeStatus: true },
  });

  if (row?.previousEnvelopeId && row.financeStatus !== null) {
    return 'APPROVAL';
  }

  // Fase 9: toda nota do envio precisa de conta ativa e centro.
  const nfs = (await loadInvoiceFiles(envelopeId)).filter((file) => file.kind === RevalleInvoiceFileKind.NF);
  const codes = nfs.map((file) => file.choiceCode).filter((code): code is string => Boolean(code));
  const active = new Set(
    (
      await prisma.revalleAccountingAccount.findMany({
        where: { code: { in: codes }, active: true },
        select: { code: true },
      })
    ).map((account) => account.code),
  );
  const missing = nfs.filter(
    (file) => !file.choiceCode || !active.has(file.choiceCode) || !isCostCenterCode(file.costCenterCode),
  );

  if (nfs.length === 0 || missing.length > 0) {
    throw invoiceChoiceRequiredError(nfs.length > 1 ? missing.map((file) => file.title) : []);
  }

  return 'APPROVAL';
};

const changedError = (what: 'conta' | 'centro') =>
  new AppError(AppErrorCode.INVALID_REQUEST, {
    message:
      what === 'conta'
        ? 'O documento mudou enquanto a conta era escolhida. Tente de novo.'
        : 'O documento mudou enquanto o centro de custo era escolhido. Tente de novo.',
  });

/** O envio é NF e a nota em que a gravação vale (Fase 9: `envelopeItemId`, obrigatório com 2+ notas). */
const loadInvoiceForChoice = async (envelopeId: string, envelopeItemId: string | undefined) => {
  const row = await prisma.revalleInvoiceClassification.findUnique({ where: { envelopeId } });

  if (!row || row.isInvoice !== RevalleInvoiceStatus.YES) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'O documento não está marcado como nota fiscal.' });
  }

  return { row, file: await resolveInvoiceFile({ envelopeId, envelopeItemId }) };
};

const auditDocumentOf = async (envelopeId: string, file: LoadedInvoiceFile) =>
  invoiceAuditDocument(file, invoicePositions(await loadInvoiceFiles(envelopeId)));

/**
 * Grava a conta escolhida (só conta ativa), com quem e quando, e registra no log de auditoria (de → para).
 * `acceptedSuggestion`: se havia sugestão, se a escolha é a conta sugerida; sem sugestão, vazio. A mesma escolha de
 * novo não grava nada.
 * - Rascunho: quem acessa o documento escolhe e troca à vontade.
 * - Depois do envio (Fase 6): quem troca a conta é o Financeiro (403). A única escolha que ainda vale é a PRIMEIRA
 *   conta de um documento marcado como NF depois do envio (sem escolha), feita pelo dono ou pelo admin.
 */
export const setInvoiceChoice = async ({
  envelopeId,
  envelopeItemId,
  choice,
  user,
  requestMetadata,
}: {
  envelopeId: string;
  /** Fase 9: a nota (arquivo). Sem ele, vale a nota única; com 2+ notas, 400 `INVOICE_FILE_REQUIRED`. */
  envelopeItemId?: string;
  choice: InvoiceChoice;
  user: { id: number; name: string | null; email: string };
  requestMetadata?: RequestMetadata;
}): Promise<InvoiceState> => {
  const isDraft = await isEnvelopeDraft(envelopeId);
  const current = await prisma.revalleInvoiceClassification.findUnique({
    where: { envelopeId },
    select: { financeStatus: true, choiceCode: true, previousEnvelopeId: true },
  });

  if (current?.financeStatus === RevalleFinanceStatus.SUPERSEDED) {
    throw supersededError();
  }

  if (isDraft && isDraftFinanceStatusLocked(current)) {
    throw financeDecidesError();
  }

  if (!isDraft && current?.choiceCode) {
    throw financeDecidesError();
  }

  if (!isDraft) {
    const [envelope, account] = await Promise.all([
      prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId }, select: { userId: true } }),
      prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { roles: true } }),
    ]);

    if (envelope.userId !== user.id && !isAdmin(account)) {
      throw new AppError(AppErrorCode.FORBIDDEN, {
        message: 'Depois do envio, só o dono do documento ou o administrador escolhe a conta.',
      });
    }
  }

  // No rascunho, garante a classificação dos arquivos atuais (a escolha vale para eles). Depois, UMA leitura da
  // linha do envio e da nota dá a sugestão e a condição da gravação: as duas valem para a mesma versão.
  if (isDraft) {
    await classifyEnvelope(envelopeId, { userId: user.id });
  } else {
    await ensureLegacyInvoiceFiles(envelopeId, { withoutTextOnReadError: true });
  }

  const { row, file } = await loadInvoiceForChoice(envelopeId, envelopeItemId);

  if (!isDraft && file.choiceCode) {
    throw financeDecidesError();
  }

  const account = await prisma.revalleAccountingAccount.findUnique({
    where: { code: choice.code },
    select: { active: true },
  });

  if (!account?.active) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'Conta contábil inativa ou inexistente.' });
  }

  if (file.choiceCode === choice.code) {
    return await getInvoiceState(envelopeId);
  }

  const toCode = choice.code;
  const suggestion = await invoiceFileSuggestion(file);
  const document = await auditDocumentOf(envelopeId, file);

  await prisma.$transaction(async (tx) => {
    // Condicionada ao que foi lido: se os arquivos mudaram (ou outra escolha entrou, ou saiu um envio) no meio, nada é
    // gravado. A trava do envio vem antes de tudo (a mesma ordem da selagem).
    const locked = await lockInvoiceEnvelope(tx, envelopeId);

    if (!locked || locked.fileSha256 !== row.fileSha256 || locked.financeStatus !== row.financeStatus) {
      throw changedError('conta');
    }

    const { count } = await tx.revalleInvoiceFile.updateMany({
      where: {
        id: file.id,
        kind: RevalleInvoiceFileKind.NF,
        fileSha256: file.fileSha256,
        choiceCode: file.choiceCode,
      },
      data: {
        choiceCode: toCode,
        choiceById: user.id,
        choiceAt: new Date(),
        acceptedSuggestion: suggestion ? toCode === suggestion.accountCode : null,
      },
    });

    if (count === 0) {
      throw changedError('conta');
    }

    await syncInvoiceEnvelopeMirror(tx, envelopeId);

    await tx.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_INVOICE_ACCOUNT_SET,
        envelopeId,
        data: { fromCode: file.choiceCode, toCode, ...document },
        user,
        requestMetadata,
      }),
    });
  });

  return await getInvoiceState(envelopeId);
};

/**
 * Grava o centro de custo da NF (só da lista fixa), com quem e quando, e registra no log de auditoria (de → para).
 * Espelha `setInvoiceChoice`: a mesma escolha de novo não grava nada e a gravação é condicionada ao que foi lido.
 * - Rascunho: quem acessa o documento escolhe e troca à vontade (salvo a nova versão com o envio parado).
 * - Depois do envio: só a PRIMEIRA escolha, pelo dono ou pelo admin, sem nova versão (ninguém viu centro ao assinar), e
 *   só numa NF viva (enviada ou concluída, sem recusa nem exclusão: `loadActionableInvoice`). Quem corrige um centro já
 *   escolhido é a Contabilidade (403 aqui).
 * - Versão substituída: nunca (403); a nova versão é que vale.
 */
export const setInvoiceCostCenter = async ({
  envelopeId,
  envelopeItemId,
  code,
  user,
  requestMetadata,
}: {
  envelopeId: string;
  /** Fase 9: a nota (arquivo). Sem ele, vale a nota única; com 2+ notas, 400 `INVOICE_FILE_REQUIRED`. */
  envelopeItemId?: string;
  code: string;
  user: { id: number; name: string | null; email: string };
  requestMetadata?: RequestMetadata;
}): Promise<InvoiceState> => {
  if (!isCostCenterCode(code)) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'Centro de custo inexistente.' });
  }

  const isDraft = await isEnvelopeDraft(envelopeId);
  const current = await prisma.revalleInvoiceClassification.findUnique({
    where: { envelopeId },
    select: { financeStatus: true, costCenterCode: true, previousEnvelopeId: true },
  });

  if (current?.financeStatus === RevalleFinanceStatus.SUPERSEDED) {
    throw supersededError();
  }

  if (isDraft && isDraftFinanceStatusLocked(current)) {
    throw new AppError(AppErrorCode.FORBIDDEN, {
      message: INVOICE_COST_CENTER_LOCKED_MESSAGE,
      userMessage: INVOICE_COST_CENTER_LOCKED_MESSAGE,
    });
  }

  if (!isDraft && current?.costCenterCode) {
    throw new AppError(AppErrorCode.FORBIDDEN, {
      message: INVOICE_COST_CENTER_AFTER_SEND_MESSAGE,
      userMessage: INVOICE_COST_CENTER_AFTER_SEND_MESSAGE,
    });
  }

  if (!isDraft) {
    const [envelope, account] = await Promise.all([
      prisma.envelope.findUniqueOrThrow({ where: { id: envelopeId }, select: { userId: true } }),
      prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { roles: true } }),
    ]);

    if (envelope.userId !== user.id && !isAdmin(account)) {
      throw new AppError(AppErrorCode.FORBIDDEN, {
        message: 'Depois do envio, só o dono do documento ou o administrador escolhe o centro de custo.',
      });
    }
  }

  if (isDraft) {
    await classifyEnvelope(envelopeId, { userId: user.id });
  } else {
    await ensureLegacyInvoiceFiles(envelopeId, { withoutTextOnReadError: true });
  }

  const { row, file } = await loadInvoiceForChoice(envelopeId, envelopeItemId);

  if (!isDraft && file.costCenterCode) {
    throw new AppError(AppErrorCode.FORBIDDEN, {
      message: INVOICE_COST_CENTER_AFTER_SEND_MESSAGE,
      userMessage: INVOICE_COST_CENTER_AFTER_SEND_MESSAGE,
    });
  }

  // Depois do envio, a mesma guarda do `define` da Contabilidade: NF recusada, cancelada ou excluída não ganha centro.
  if (!isDraft) {
    await loadActionableInvoice(envelopeId);
  }

  if (file.costCenterCode === code) {
    return await getInvoiceState(envelopeId);
  }

  const document = await auditDocumentOf(envelopeId, file);

  await prisma.$transaction(async (tx) => {
    // Condicionada ao que foi lido: se os arquivos mudaram (ou outro centro entrou, ou a NF foi substituída) no meio,
    // nada é gravado.
    const locked = await lockInvoiceEnvelope(tx, envelopeId);

    if (!locked || locked.fileSha256 !== row.fileSha256 || locked.financeStatus !== row.financeStatus) {
      throw changedError('centro');
    }

    const { count } = await tx.revalleInvoiceFile.updateMany({
      where: {
        id: file.id,
        kind: RevalleInvoiceFileKind.NF,
        fileSha256: file.fileSha256,
        costCenterCode: file.costCenterCode,
      },
      data: { costCenterCode: code, costCenterById: user.id, costCenterAt: new Date() },
    });

    if (count === 0) {
      throw changedError('centro');
    }

    await syncInvoiceEnvelopeMirror(tx, envelopeId);

    await tx.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_INVOICE_COST_CENTER_SET,
        envelopeId,
        data: { fromCode: file.costCenterCode, toCode: code, ...document },
        user,
        requestMetadata,
      }),
    });
  });

  return await getInvoiceState(envelopeId);
};
