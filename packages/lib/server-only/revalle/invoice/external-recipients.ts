import { prisma } from '@documenso/prisma';
import { DocumentStatus, RevalleInvoiceStatus } from '@prisma/client';

import { getAllowedSignupDomains } from '../../../constants/auth';
import { AppError } from '../../../errors/app-error';
import { findExternalEmail, formatInvoiceExternalRecipientMessage } from '../../../revalle/recipient-domains';

/** Nota fiscal com destinatário de fora da empresa (a tela mostra a mensagem do servidor, que nomeia o e-mail). */
export const INVOICE_EXTERNAL_RECIPIENT_CODE = 'INVOICE_EXTERNAL_RECIPIENT';

/**
 * Nota fiscal só vai para e-mails da empresa (decisão de 16/11/2026: documento comum vai para qualquer e-mail). Recusa
 * com 400 `INVOICE_EXTERNAL_RECIPIENT`, nomeando o primeiro e-mail de fora.
 */
export const assertInvoiceRecipientEmails = (emails: Array<string | null | undefined>): void => {
  const domains = getAllowedSignupDomains();
  const external = findExternalEmail(emails, domains);

  if (external) {
    const message = formatInvoiceExternalRecipientMessage(external, domains);

    throw new AppError(INVOICE_EXTERNAL_RECIPIENT_CODE, { message, userMessage: message, statusCode: 400 });
  }
};

export const isRevalleInvoiceEnvelope = async (envelopeId: string): Promise<boolean> => {
  const row = await prisma.revalleInvoiceClassification.findUnique({
    where: { envelopeId },
    select: { isInvoice: true },
  });

  return row?.isInvoice === RevalleInvoiceStatus.YES;
};

/**
 * Destinatários gravados ou trocados num documento JÁ ENVIADO que é nota fiscal (editar destinatário, próximo assinante
 * ditado, e-mail informado ao assinar). No rascunho a troca é livre: a recusa é no envio (`sendDocument`), e a tela avisa
 * antes no bloco da nota fiscal.
 */
export const assertSentInvoiceRecipientEmails = async (
  envelopeId: string,
  emails: Array<string | null | undefined>,
): Promise<void> => {
  if (!findExternalEmail(emails, getAllowedSignupDomains())) {
    return;
  }

  const envelope = await prisma.envelope.findUnique({ where: { id: envelopeId }, select: { status: true } });

  if (envelope?.status === DocumentStatus.DRAFT) {
    return;
  }

  if (await isRevalleInvoiceEnvelope(envelopeId)) {
    assertInvoiceRecipientEmails(emails);
  }
};
