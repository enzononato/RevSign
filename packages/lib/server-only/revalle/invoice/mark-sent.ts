import { prisma } from '@documenso/prisma';
import {
  DocumentStatus,
  Prisma,
  RevalleInvoiceDetectedBy,
  RevalleInvoiceStatus,
  RevalleSuggestionStatus,
} from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { isAdmin } from '../../../utils/is-admin';
import { emailAccountingIfCompleted } from './accounting-email';
import type { InvoiceState } from './classify';
import { getInvoiceState, toInvoiceState } from './classify';
import { filesKey, loadEnvelopeFiles } from './envelope-files';

/**
 * Documento JÁ ENVIADO (pendente ou concluído) que não ficou como NF (`UNKNOWN`, `NO` ou sem classificação, ex.: NF
 * escaneada enviada sem responder "É nota fiscal?"): o dono ou o admin marca como NF na página do documento.
 * A classificação continua congelada (nada é relido nem reclassificado) e a IA não é chamada: grava `isInvoice = YES`,
 * `detectedBy = SENDER` e quem/quando. A escolha da conta vem em seguida, no mesmo cartão (`setInvoiceChoice`); num
 * documento concluído, é ela que dispara o e-mail da contabilidade. Já marcado como NF: devolve o estado, sem gravar.
 */
export const markSentEnvelopeAsInvoice = async ({
  envelopeId,
  user,
}: {
  envelopeId: string;
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
    return await toInvoiceState(row);
  }

  const marked = {
    isInvoice: RevalleInvoiceStatus.YES,
    detectedBy: RevalleInvoiceDetectedBy.SENDER,
    flagChangedById: user.id,
    flagChangedAt: new Date(),
    // Sem IA depois do envio: a sugestão fica de fora.
    suggestionStatus: RevalleSuggestionStatus.SKIPPED,
    suggestion: Prisma.DbNull,
  };

  if (row) {
    // Condicionada ao que foi lido: dois cliques ao mesmo tempo gravam uma vez.
    await prisma.revalleInvoiceClassification.updateMany({
      where: { envelopeId, isInvoice: row.isInvoice },
      data: marked,
    });
  } else {
    // Enviado antes desta versão (sem linha): a chave é a dos arquivos ORIGINAIS, como na classificação.
    const fileSha256 = filesKey(await loadEnvelopeFiles(envelopeId));

    await prisma.revalleInvoiceClassification.createMany({
      data: [{ envelopeId, ...marked, signals: [], fileSha256 }],
      skipDuplicates: true,
    });
  }

  // Raro: o remetente tinha escolhido a conta no rascunho e depois disse "Não" (a escolha fica). Concluído com escolha:
  // a contabilidade é avisada já.
  await emailAccountingIfCompleted(envelopeId);

  return await getInvoiceState(envelopeId);
};
