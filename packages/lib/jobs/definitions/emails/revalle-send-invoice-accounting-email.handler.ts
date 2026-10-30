import { RevalleInvoiceAccountingTemplate } from '@documenso/email/templates/revalle-invoice-accounting';
import { prisma } from '@documenso/prisma';
import { EnvelopeType, RevalleInvoiceStatus } from '@prisma/client';
import { createElement } from 'react';

import { NEXT_PUBLIC_WEBAPP_URL } from '../../../constants/app';
import { formatRevalleDateTime } from '../../../revalle/date-format';
import { getEmailContext } from '../../../server-only/email/get-email-context';
import { getAccountingSettings } from '../../../server-only/revalle/invoice/settings';
import { getFileServerSide } from '../../../universal/upload/get-file.server';
import { unsafeBuildEnvelopeIdQuery } from '../../../utils/envelope';
import { renderEmailWithI18N } from '../../../utils/render-email-with-i18n';
import type { JobRunIO } from '../../client/_internal/job';
import type { TRevalleSendInvoiceAccountingEmailJobDefinition } from './revalle-send-invoice-accounting-email';

export const buildInvoiceAccountingSubject = (title: string, account: { code: string; name: string } | null) =>
  account
    ? `Nota fiscal assinada: ${title} · Conta ${account.code} – ${account.name}`
    : `Nota fiscal assinada: ${title} · Conta: a definir pela contabilidade`;

/**
 * Envia o PDF selado da nota fiscal concluída para a contabilidade, uma única vez por documento.
 * A vaga é reservada antes do envio (`accountingEmailSentAt` null -> agora); se o envio falha, a vaga é devolvida
 * para o retry do job poder enviar. Reselagem e retries nunca reenviam um e-mail já enviado.
 */
export const run = async ({
  payload,
  io,
}: {
  payload: TRevalleSendInvoiceAccountingEmailJobDefinition;
  io: JobRunIO;
}) => {
  const { envelopeId } = payload;

  const { accountingEmail } = await getAccountingSettings();

  if (!accountingEmail) {
    return;
  }

  const classification = await prisma.revalleInvoiceClassification.findUnique({ where: { envelopeId } });

  if (
    !classification ||
    classification.isInvoice !== RevalleInvoiceStatus.YES ||
    classification.accountingEmailSentAt !== null
  ) {
    return;
  }

  const envelope = await prisma.envelope.findUnique({
    where: unsafeBuildEnvelopeIdQuery({ type: 'envelopeId', id: envelopeId }, EnvelopeType.DOCUMENT),
    include: {
      envelopeItems: { orderBy: { order: 'asc' }, include: { documentData: true } },
      documentMeta: true,
      user: { select: { name: true, email: true, disabled: true } },
    },
  });

  if (!envelope) {
    throw new Error('Document not found');
  }

  // Sem escolha (documento antigo que chegou ao fim sem conta) segue o texto de "a contabilidade decide".
  const account =
    !classification.choiceDefer && classification.choiceCode
      ? await prisma.revalleAccountingAccount.findUnique({
          where: { code: classification.choiceCode },
          select: { code: true, name: true },
        })
      : null;

  const { branding, emailLanguage, senderEmail, emailsDisabled, emailTransport } = await getEmailContext({
    emailType: 'INTERNAL',
    source: { type: 'team', teamId: envelope.teamId },
    meta: envelope.documentMeta,
  });

  if (envelope.user.disabled || emailsDisabled) {
    return;
  }

  // Mesmos arquivos dos e-mails de conclusão: o PDF selado de cada item (o certificado já está dentro dele).
  const attachments = await Promise.all(
    envelope.envelopeItems.map(async (envelopeItem) => {
      const file = await getFileServerSide(envelopeItem.documentData);
      const fileName = envelope.internalVersion === 1 ? envelope.title : `${envelopeItem.title}.pdf`;

      return {
        filename: fileName.endsWith('.pdf') ? fileName : `${fileName}.pdf`,
        content: Buffer.from(file),
        contentType: 'application/pdf',
      };
    }),
  );

  const template = createElement(RevalleInvoiceAccountingTemplate, {
    documentName: envelope.title,
    senderName: envelope.user.name || envelope.user.email,
    senderEmail: envelope.user.email,
    completedAt: formatRevalleDateTime(envelope.completedAt ?? new Date(), { withZoneLabel: true }),
    account: account ? `${account.code} – ${account.name}` : null,
    origin:
      classification.acceptedSuggestion === true
        ? 'SUGGESTION_ACCEPTED'
        : classification.acceptedSuggestion === false
          ? 'CHOSEN'
          : null,
    assetBaseUrl: NEXT_PUBLIC_WEBAPP_URL() || 'http://localhost:3000',
  });

  const [html, text] = await Promise.all([
    renderEmailWithI18N(template, { lang: emailLanguage, branding }),
    renderEmailWithI18N(template, { lang: emailLanguage, branding, plainText: true }),
  ]);

  // Reserva a vaga: só quem muda null -> agora envia (dois jobs ao mesmo tempo ou uma reselagem não duplicam).
  const claimed = await prisma.revalleInvoiceClassification.updateMany({
    where: { envelopeId, accountingEmailSentAt: null },
    data: { accountingEmailSentAt: new Date() },
  });

  if (claimed.count === 0) {
    return;
  }

  try {
    await emailTransport.sendMail({
      to: [{ name: '', address: accountingEmail }],
      from: senderEmail,
      subject: buildInvoiceAccountingSubject(envelope.title, account),
      html,
      text,
      attachments,
    });
  } catch (error) {
    // Devolve a vaga para o retry do job poder enviar.
    await prisma.revalleInvoiceClassification.updateMany({
      where: { envelopeId },
      data: { accountingEmailSentAt: null },
    });

    io.logger.error({ msg: 'Falha ao enviar o e-mail da contabilidade', envelopeId });

    throw error;
  }
};
