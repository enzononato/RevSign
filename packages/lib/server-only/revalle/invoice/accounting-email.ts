import { prisma } from '@documenso/prisma';
import type { RevalleFinanceStatus } from '@prisma/client';
import { DocumentStatus, RevalleInvoiceStatus } from '@prisma/client';

import { jobs } from '../../../jobs/client';
import { getAccountingSettings } from './settings';

/** Fase 6: a contabilidade só recebe a NF aprovada pelo Financeiro ou anterior à Fase 6 (`LEGACY`). */
export const FINANCE_CLEARED_STATUSES = ['APPROVED', 'LEGACY'] as const satisfies RevalleFinanceStatus[];

export const isFinanceCleared = (status: RevalleFinanceStatus | null | undefined): boolean =>
  FINANCE_CLEARED_STATUSES.some((cleared) => cleared === status);

// Fase 5: o job da contabilidade só é disparado para nota fiscal ainda não avisada e com e-mail configurado.
// Fase 6: e liberada pelo Financeiro (o job confere de novo).
export const shouldEmailInvoiceAccounting = async (envelopeId: string): Promise<boolean> => {
  const [{ accountingEmail }, classification] = await Promise.all([
    getAccountingSettings(),
    prisma.revalleInvoiceClassification.findUnique({
      where: { envelopeId },
      select: { isInvoice: true, accountingEmailSentAt: true, financeStatus: true },
    }),
  ]);

  return Boolean(
    accountingEmail &&
      classification?.isInvoice === RevalleInvoiceStatus.YES &&
      !classification.accountingEmailSentAt &&
      isFinanceCleared(classification.financeStatus),
  );
};

/**
 * Documento JÁ CONCLUÍDO marcado como NF depois do envio (ex.: NF escaneada enviada sem resposta): quando a conta
 * (ou "Deixar para o Financeiro", NF de antes da Fase 6) é gravada, a contabilidade recebe o e-mail que não saiu na conclusão.
 * Fase 6: a NF marcada depois do envio fica `PENDING_APPROVAL`, então o e-mail só sai na aprovação do Financeiro
 * (que chama esta função de novo).
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
