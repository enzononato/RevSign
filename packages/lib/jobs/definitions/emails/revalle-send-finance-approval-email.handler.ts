import { RevalleFinanceApprovalNeededTemplate } from '@documenso/email/templates/revalle-finance-approval-needed';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, RevalleFinanceStatus } from '@prisma/client';
import { createElement } from 'react';

import { NEXT_PUBLIC_WEBAPP_URL } from '../../../constants/app';
import { getEmailContext } from '../../../server-only/email/get-email-context';
import { listFinanceMemberEmails } from '../../../server-only/revalle/finance/members';
import { renderEmailWithI18N } from '../../../utils/render-email-with-i18n';
import type { JobRunIO } from '../../client/_internal/job';
import type { TRevalleSendFinanceApprovalEmailJobDefinition } from './revalle-send-finance-approval-email';

export const buildFinanceApprovalSubject = (title: string) =>
  `Nota fiscal aguardando aprovação do Financeiro: ${title}`;

// A página da NF só de leitura para o Financeiro vem na Task 6; até lá, a lista filtrada.
export const FINANCE_PENDING_INVOICES_PATH = '/notas-fiscais?financeiro=pendentes';

/**
 * Um e-mail por retenção da selagem, para todos os membros do Financeiro (num envio só). A marca `approvalRequestedAt`
 * é reservada antes do envio (nula -> agora, só enquanto a NF continua `PENDING_APPROVAL`); se o envio falha, ela é
 * devolvida para o retry do job. Sem membros, nada é reservado: o próximo disparo da selagem pede de novo.
 * O status do envelope pode ainda ser DRAFT: o atalho do envio sem destinatários atuantes retém antes de gravar PENDING.
 */
export const run = async ({
  payload,
  io,
}: {
  payload: TRevalleSendFinanceApprovalEmailJobDefinition;
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
      revalleInvoice: { select: { financeStatus: true, approvalRequestedAt: true, choiceCode: true } },
    },
  });

  if (
    !envelope ||
    envelope.deletedAt ||
    (envelope.status !== DocumentStatus.PENDING && envelope.status !== DocumentStatus.DRAFT) ||
    envelope.revalleInvoice?.financeStatus !== RevalleFinanceStatus.PENDING_APPROVAL ||
    envelope.revalleInvoice.approvalRequestedAt
  ) {
    return;
  }

  const members = await listFinanceMemberEmails();

  if (members.length === 0) {
    io.logger.warn({ msg: 'NF retida sem ninguém no Financeiro para aprovar', envelopeId });

    return;
  }

  const { choiceCode } = envelope.revalleInvoice;
  const account = choiceCode
    ? await prisma.revalleAccountingAccount.findUnique({ where: { code: choiceCode }, select: { name: true } })
    : null;

  // E-mail interno: não depende das preferências de e-mail do remetente nem da organização.
  const { branding, emailLanguage, senderEmail, emailTransport } = await getEmailContext({
    emailType: 'INTERNAL',
    source: { type: 'team', teamId: envelope.teamId },
    meta: envelope.documentMeta,
  });

  const assetBaseUrl = NEXT_PUBLIC_WEBAPP_URL() || 'http://localhost:3000';

  const template = createElement(RevalleFinanceApprovalNeededTemplate, {
    documentName: envelope.title,
    senderName: envelope.user.name || envelope.user.email,
    senderEmail: envelope.user.email,
    account: account ? `${choiceCode} – ${account.name}` : (choiceCode ?? '-'),
    invoicesUrl: `${assetBaseUrl}${FINANCE_PENDING_INVOICES_PATH}`,
    assetBaseUrl,
  });

  const [html, text] = await Promise.all([
    renderEmailWithI18N(template, { lang: emailLanguage, branding }),
    renderEmailWithI18N(template, { lang: emailLanguage, branding, plainText: true }),
  ]);

  const claimed = await prisma.revalleInvoiceClassification.updateMany({
    where: { envelopeId, financeStatus: RevalleFinanceStatus.PENDING_APPROVAL, approvalRequestedAt: null },
    data: { approvalRequestedAt: new Date() },
  });

  if (claimed.count === 0) {
    return;
  }

  try {
    await emailTransport.sendMail({
      to: members.map((address) => ({ name: '', address })),
      from: senderEmail,
      subject: buildFinanceApprovalSubject(envelope.title),
      html,
      text,
    });
  } catch (error) {
    await prisma.revalleInvoiceClassification.updateMany({
      where: { envelopeId },
      data: { approvalRequestedAt: null },
    });

    io.logger.error({ msg: 'Falha ao enviar o pedido de aprovação ao Financeiro', envelopeId });

    throw error;
  }
};
