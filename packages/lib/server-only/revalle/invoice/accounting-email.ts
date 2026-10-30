import { prisma } from '@documenso/prisma';
import { DocumentStatus, RevalleInvoiceStatus } from '@prisma/client';

import { jobs } from '../../../jobs/client';
import { getAccountingSettings } from './settings';

// Fase 5: o job da contabilidade só é disparado para nota fiscal ainda não avisada e com e-mail configurado.
export const shouldEmailInvoiceAccounting = async (envelopeId: string): Promise<boolean> => {
  const [{ accountingEmail }, classification] = await Promise.all([
    getAccountingSettings(),
    prisma.revalleInvoiceClassification.findUnique({
      where: { envelopeId },
      select: { isInvoice: true, accountingEmailSentAt: true },
    }),
  ]);

  return Boolean(
    accountingEmail && classification?.isInvoice === RevalleInvoiceStatus.YES && !classification.accountingEmailSentAt,
  );
};

/**
 * Documento JÁ CONCLUÍDO marcado como NF depois do envio (ex.: NF escaneada enviada sem resposta): quando a conta
 * (ou "Deixar para a contabilidade decidir") é gravada, a contabilidade recebe o e-mail que não saiu na conclusão.
 * O job reserva `accountingEmailSentAt` antes de enviar: uma NF gera no máximo um e-mail, e trocar a conta de uma NF
 * já avisada não reenvia. Sem escolha, nada sai (a tela exige a escolha logo depois de marcar).
 */
export const emailAccountingIfCompleted = async (envelopeId: string) => {
  const [envelope, classification] = await Promise.all([
    prisma.envelope.findUnique({ where: { id: envelopeId }, select: { status: true } }),
    prisma.revalleInvoiceClassification.findUnique({
      where: { envelopeId },
      select: { choiceCode: true, choiceDefer: true },
    }),
  ]);

  if (
    envelope?.status !== DocumentStatus.COMPLETED ||
    !classification ||
    (!classification.choiceCode && !classification.choiceDefer)
  ) {
    return;
  }

  if (await shouldEmailInvoiceAccounting(envelopeId)) {
    await jobs.triggerJob({ name: 'send.revalle.invoice.accounting.email', payload: { envelopeId } });
  }
};
