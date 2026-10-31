import { RevalleFinanceAwaitingTemplate } from '@documenso/email/templates/revalle-finance-awaiting';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, RevalleFinanceStatus } from '@prisma/client';
import { createElement } from 'react';

import { NEXT_PUBLIC_WEBAPP_URL } from '../../../constants/app';
import { invoiceViewPath } from '../../../revalle/finance/finance-status';
import { getEmailContext } from '../../../server-only/email/get-email-context';
import { listFinanceMemberEmails } from '../../../server-only/revalle/finance/members';
import { renderEmailWithI18N } from '../../../utils/render-email-with-i18n';
import type { JobRunIO } from '../../client/_internal/job';
import type { TRevalleSendFinanceAwaitingEmailJobDefinition } from './revalle-send-finance-awaiting-email';

export const buildFinanceAwaitingSubject = (title: string) => `Nota fiscal aguardando o Financeiro: ${title}`;

/**
 * Um e-mail por retenção, para todos os membros do Financeiro (num envio só). A marca `accountRequestedAt` é
 * reservada antes do envio (nula -> agora, só enquanto a NF continua retida); se o envio falha, ela é devolvida para o
 * retry do job. Sem membros, nada é reservado: o aviso sai no próximo envio retido.
 */
export const run = async ({
  payload,
  io,
}: {
  payload: TRevalleSendFinanceAwaitingEmailJobDefinition;
  io: JobRunIO;
}) => {
  const { envelopeId } = payload;

  const envelope = await prisma.envelope.findUnique({
    where: { id: envelopeId },
    select: {
      title: true,
      status: true,
      teamId: true,
      deletedAt: true,
      documentMeta: true,
      user: { select: { name: true, email: true } },
      revalleInvoice: { select: { financeStatus: true, accountRequestedAt: true } },
    },
  });

  if (
    !envelope ||
    envelope.status !== DocumentStatus.DRAFT ||
    envelope.deletedAt ||
    envelope.revalleInvoice?.financeStatus !== RevalleFinanceStatus.AWAITING_ACCOUNT ||
    envelope.revalleInvoice.accountRequestedAt
  ) {
    return;
  }

  const members = await listFinanceMemberEmails();

  if (members.length === 0) {
    io.logger.warn({ msg: 'NF retida sem ninguém no Financeiro para avisar', envelopeId });

    return;
  }

  // E-mail interno: não depende das preferências de e-mail do remetente nem da organização.
  const { branding, emailLanguage, senderEmail, emailTransport } = await getEmailContext({
    emailType: 'INTERNAL',
    source: { type: 'team', teamId: envelope.teamId },
    meta: envelope.documentMeta,
  });

  const assetBaseUrl = NEXT_PUBLIC_WEBAPP_URL() || 'http://localhost:3000';

  const template = createElement(RevalleFinanceAwaitingTemplate, {
    documentName: envelope.title,
    senderName: envelope.user.name || envelope.user.email,
    senderEmail: envelope.user.email,
    // A página da NF (só leitura), onde fica o cartão do Financeiro com "Definir conta e enviar".
    invoiceUrl: `${assetBaseUrl}${invoiceViewPath(envelopeId)}`,
    assetBaseUrl,
  });

  const [html, text] = await Promise.all([
    renderEmailWithI18N(template, { lang: emailLanguage, branding }),
    renderEmailWithI18N(template, { lang: emailLanguage, branding, plainText: true }),
  ]);

  const claimed = await prisma.revalleInvoiceClassification.updateMany({
    where: { envelopeId, financeStatus: RevalleFinanceStatus.AWAITING_ACCOUNT, accountRequestedAt: null },
    data: { accountRequestedAt: new Date() },
  });

  if (claimed.count === 0) {
    return;
  }

  try {
    await emailTransport.sendMail({
      to: members.map((address) => ({ name: '', address })),
      from: senderEmail,
      subject: buildFinanceAwaitingSubject(envelope.title),
      html,
      text,
    });
  } catch (error) {
    await prisma.revalleInvoiceClassification.updateMany({
      where: { envelopeId },
      data: { accountRequestedAt: null },
    });

    io.logger.error({ msg: 'Falha ao enviar o aviso ao Financeiro', envelopeId });

    throw error;
  }
};
