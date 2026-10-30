import { RevalleInvoiceAccountingTemplate } from '@documenso/email/templates/revalle-invoice-accounting';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType, RevalleInvoiceStatus } from '@prisma/client';
import { createElement } from 'react';

import { NEXT_PUBLIC_WEBAPP_URL } from '../../../constants/app';
import { formatRevalleDateTime } from '../../../revalle/date-format';
import { getEmailContext } from '../../../server-only/email/get-email-context';
import { FINANCE_CLEARED_STATUSES, isFinanceCleared } from '../../../server-only/revalle/invoice/accounting-email';
import { getAccountingSettings } from '../../../server-only/revalle/invoice/settings';
import { getFileServerSide } from '../../../universal/upload/get-file.server';
import { unsafeBuildEnvelopeIdQuery } from '../../../utils/envelope';
import { renderEmailWithI18N } from '../../../utils/render-email-with-i18n';
import type { JobRunIO } from '../../client/_internal/job';
import type { TRevalleSendInvoiceAccountingEmailJobDefinition } from './revalle-send-invoice-accounting-email';

export const buildInvoiceAccountingSubject = (title: string, account: { code: string; name: string } | null) =>
  account
    ? `Nota fiscal assinada: ${title} · Conta ${account.code} – ${account.name}`
    : `Nota fiscal assinada: ${title} · Conta: a definir pelo Financeiro`;

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
    classification.accountingEmailSentAt !== null ||
    // Fase 6: só a NF aprovada pelo Financeiro (ou anterior à Fase 6); nunca a pendente nem a substituída.
    !isFinanceCleared(classification.financeStatus)
  ) {
    return;
  }

  const envelope = await prisma.envelope.findUnique({
    where: unsafeBuildEnvelopeIdQuery({ type: 'envelopeId', id: envelopeId }, EnvelopeType.DOCUMENT),
    include: {
      envelopeItems: { orderBy: { order: 'asc' }, include: { documentData: true } },
      documentMeta: true,
      user: { select: { name: true, email: true } },
    },
  });

  if (!envelope) {
    throw new Error('Document not found');
  }

  // Só documento concluído (nada de rascunho, em andamento ou recusado).
  if (envelope.status !== DocumentStatus.COMPLETED) {
    return;
  }

  // Sem escolha (documento antigo que chegou ao fim sem conta) segue o texto de "a definir pelo Financeiro".
  const account =
    !classification.choiceDefer && classification.choiceCode
      ? await prisma.revalleAccountingAccount.findUnique({
          where: { code: classification.choiceCode },
          select: { code: true, name: true },
        })
      : null;

  // E-mail interno: não depende de o usuário estar ativo nem das preferências de e-mail do remetente/organização.
  const { branding, emailLanguage, senderEmail, emailTransport } = await getEmailContext({
    emailType: 'INTERNAL',
    source: { type: 'team', teamId: envelope.teamId },
    meta: envelope.documentMeta,
  });

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
    // "Escolhida pelo remetente" só faz sentido quando há conta; "deixar para o Financeiro" não tem linha de origem.
    origin: !account
      ? null
      : classification.acceptedSuggestion === true
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
  // Condicionada também à liberação do Financeiro, relida aqui (uma troca de conta no meio não manda a versão velha).
  const claimed = await prisma.revalleInvoiceClassification.updateMany({
    where: { envelopeId, accountingEmailSentAt: null, financeStatus: { in: [...FINANCE_CLEARED_STATUSES] } },
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
