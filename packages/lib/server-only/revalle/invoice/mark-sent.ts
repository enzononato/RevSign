import { prisma } from '@documenso/prisma';
import {
  DocumentStatus,
  Prisma,
  RevalleFinanceStatus,
  RevalleInvoiceDetectedBy,
  RevalleInvoiceFileKind,
  RevalleInvoiceStatus,
  RevalleSuggestionStatus,
} from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { pickSentInvoiceTargets } from '../../../revalle/invoice/invoice-files';
import { isAdmin } from '../../../utils/is-admin';
import type { InvoiceState } from './classify';
import { getInvoiceState } from './classify';
import { filesKey, loadEnvelopeFiles } from './envelope-files';
import { assertInvoiceRecipientEmails } from './external-recipients';
import { loadInvoiceFiles, lockInvoiceEnvelope, syncInvoiceEnvelopeMirror } from './invoice-files';

/**
 * Documento JÁ ENVIADO (pendente ou concluído) que não ficou como NF (`UNKNOWN`, `NO` ou sem classificação, ex.: NF
 * escaneada enviada sem responder "É nota fiscal?"): o dono ou o admin marca como NF na página do documento.
 * A classificação continua congelada (nada é relido nem reclassificado) e a IA não é chamada: grava `isInvoice = YES`,
 * `detectedBy = SENDER`, quem/quando e (Fase 6) `PENDING_APPROVAL`: a NF passa pelo Financeiro. A primeira conta vem
 * em seguida, no mesmo cartão (`setInvoiceChoice`). Já marcado como NF: devolve o estado, sem gravar.
 * Fase 9: vira nota o arquivo pedido (`envelopeItemId`); sem ele, os de `pickSentInvoiceTargets` (nunca um boleto antes
 * de outro arquivo).
 * Com um destinatário de fora da empresa, recusa (`INVOICE_EXTERNAL_RECIPIENT`): NF só vai para e-mails da empresa.
 */
export const markSentEnvelopeAsInvoice = async ({
  envelopeId,
  envelopeItemId,
  user,
}: {
  envelopeId: string;
  envelopeItemId?: string;
  user: { id: number };
}): Promise<InvoiceState> => {
  const [envelope, account] = await Promise.all([
    prisma.envelope.findUnique({ where: { id: envelopeId }, select: { userId: true, status: true, deletedAt: true } }),
    prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { roles: true } }),
  ]);

  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Documento não encontrado.' });
  }

  if (envelope.userId !== user.id && !isAdmin(account)) {
    throw new AppError(AppErrorCode.FORBIDDEN, {
      message: 'Só o dono do documento ou o administrador marca o documento como nota fiscal.',
    });
  }

  const isSent = envelope.status === DocumentStatus.PENDING || envelope.status === DocumentStatus.COMPLETED;

  if (!isSent || envelope.deletedAt) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Só um documento enviado (pendente ou concluído) pode ser marcado como nota fiscal aqui.',
    });
  }

  const row = await prisma.revalleInvoiceClassification.findUnique({ where: { envelopeId } });

  if (row?.isInvoice === RevalleInvoiceStatus.YES) {
    return await getInvoiceState(envelopeId);
  }

  // Nota fiscal só vai para e-mails da empresa: com um destinatário de fora, o documento continua comum.
  const recipients = await prisma.recipient.findMany({ where: { envelopeId }, select: { email: true } });

  assertInvoiceRecipientEmails(recipients.map((recipient) => recipient.email));

  // Os arquivos ORIGINAIS: a chave do conjunto (envio de antes desta versão, sem linha) e a linha de cada arquivo.
  const files = await loadEnvelopeFiles(envelopeId);

  if (envelopeItemId !== undefined && !files.some((file) => file.envelopeItemId === envelopeItemId)) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Arquivo não encontrado neste envio.' });
  }

  const now = new Date();

  await prisma.$transaction(async (tx) => {
    if (!row) {
      // Enviado antes desta versão (sem linha): a linha só fica visível com a marca, no fim desta transação.
      await tx.revalleInvoiceClassification.createMany({
        data: [
          {
            envelopeId,
            isInvoice: RevalleInvoiceStatus.NO,
            detectedBy: RevalleInvoiceDetectedBy.TEXT,
            signals: [],
            fileSha256: filesKey(files),
          },
        ],
        skipDuplicates: true,
      });
    }

    await lockInvoiceEnvelope(tx, envelopeId);

    // Conferida de novo depois da trava: dois cliques ao mesmo tempo gravam uma vez.
    const current = await tx.revalleInvoiceClassification.findUniqueOrThrow({ where: { envelopeId } });

    if (current.isInvoice === RevalleInvoiceStatus.YES) {
      return;
    }

    // Arquivo sem linha (enviado antes da Fase 9): "outro", sem reler o texto (a classificação continua congelada).
    await tx.revalleInvoiceFile.createMany({
      data: files.map((file) => ({
        envelopeId,
        envelopeItemId: file.envelopeItemId,
        kind: RevalleInvoiceFileKind.OTHER,
        fileSha256: file.sha256,
      })),
      skipDuplicates: true,
    });

    const rows = await loadInvoiceFiles(envelopeId, tx);
    const targets =
      envelopeItemId !== undefined
        ? rows.filter((file) => file.envelopeItemId === envelopeItemId)
        : pickSentInvoiceTargets(rows);

    await tx.revalleInvoiceFile.updateMany({
      where: { id: { in: targets.map((file) => file.id) } },
      data: {
        kind: RevalleInvoiceFileKind.NF,
        detectedBy: RevalleInvoiceDetectedBy.SENDER,
        kindChangedById: user.id,
        kindChangedAt: now,
        // Sem IA depois do envio: a sugestão fica de fora.
        suggestionStatus: RevalleSuggestionStatus.SKIPPED,
        suggestion: Prisma.DbNull,
      },
    });

    await tx.revalleInvoiceClassification.update({
      where: { envelopeId },
      data: {
        isInvoice: RevalleInvoiceStatus.YES,
        detectedBy: RevalleInvoiceDetectedBy.SENDER,
        flagChangedById: user.id,
        flagChangedAt: now,
        // Fase 6: NF marcada depois do envio também passa pelo Financeiro.
        financeStatus: RevalleFinanceStatus.PENDING_APPROVAL,
      },
    });

    await syncInvoiceEnvelopeMirror(tx, envelopeId);
  });

  return await getInvoiceState(envelopeId);
};
