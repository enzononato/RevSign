import { prisma } from '@documenso/prisma';
import { RevalleInvoiceStatus } from '@prisma/client';

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
