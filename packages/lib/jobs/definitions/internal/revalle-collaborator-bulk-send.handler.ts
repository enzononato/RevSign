import { BulkSendCompleteEmail } from '@documenso/email/templates/bulk-send-complete';
import { prisma } from '@documenso/prisma';
import { msg } from '@lingui/macro';
import { createElement } from 'react';

import { getI18nInstance } from '../../../client-only/providers/i18n-server';
import { NEXT_PUBLIC_WEBAPP_URL } from '../../../constants/app';
import { getEmailContext } from '../../../server-only/email/get-email-context';
import { processCollaboratorBulkSendUpload } from '../../../server-only/revalle/collaborator-contract/bulk-send';
import { renderEmailWithI18N } from '../../../utils/render-email-with-i18n';
import type { JobRunIO } from '../../client/_internal/job';
import type { TRevalleCollaboratorBulkSendJobDefinition } from './revalle-collaborator-bulk-send';

// REVALLE (v.21): contrato para colaboradores. Cria os documentos da planilha (continuando de onde parou, se o job
// recomeçar) e, ao terminar, manda o resumo a quem enviou a planilha, como o envio em massa do upstream.
export const run = async ({ payload, io }: { payload: TRevalleCollaboratorBulkSendJobDefinition; io: JobRunIO }) => {
  const summary = await processCollaboratorBulkSendUpload({ uploadId: payload.uploadId });

  if (!summary) {
    return;
  }

  io.logger.info(
    `Collaborator contract bulk send ${payload.uploadId}: ${summary.createdCount} criado(s), ${summary.skippedCount} pulado(s), ${summary.failedCount} falha(s)`,
  );

  const [user, template] = await Promise.all([
    prisma.user.findUnique({ where: { id: summary.createdById }, select: { email: true, name: true } }),
    prisma.revalleBulkSendUpload.findUnique({
      where: { id: payload.uploadId },
      select: { contract: { select: { templateEnvelope: { select: { teamId: true } } } } },
    }),
  ]);

  const teamId = template?.contract.templateEnvelope?.teamId;

  if (!user || teamId === undefined) {
    return;
  }

  const notes = [
    ...(summary.duplicateRows > 0 ? [`Linhas repetidas (mesmo e-mail), puladas: ${summary.duplicateRows}`] : []),
    ...(summary.skippedCount > 0
      ? [`E-mails que já tinham documento deste contrato, pulados: ${summary.skippedCount}`]
      : []),
    ...(summary.failedCount > 0 ? [`Linhas que não viraram documento: ${summary.failedCount}`] : []),
  ];

  const completionTemplate = createElement(BulkSendCompleteEmail, {
    userName: user.name || user.email,
    templateName: summary.templateTitle,
    totalProcessed: summary.totalRows,
    successCount: summary.createdCount,
    failedCount: summary.failedCount,
    errors: notes,
    assetBaseUrl: NEXT_PUBLIC_WEBAPP_URL(),
  });

  const { branding, emailLanguage, senderEmail, emailTransport } = await getEmailContext({
    emailType: 'INTERNAL',
    source: { type: 'team', teamId },
  });

  const i18n = await getI18nInstance(emailLanguage);

  const [html, text] = await Promise.all([
    renderEmailWithI18N(completionTemplate, { lang: emailLanguage, branding }),
    renderEmailWithI18N(completionTemplate, { lang: emailLanguage, branding, plainText: true }),
  ]);

  await emailTransport.sendMail({
    to: { name: user.name || '', address: user.email },
    from: senderEmail,
    subject: i18n._(msg`Bulk Send Complete: ${summary.templateTitle}`),
    html,
    text,
  });
};
