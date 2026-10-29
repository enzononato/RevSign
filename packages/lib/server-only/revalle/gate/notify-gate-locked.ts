import { RevalleGateLockedTemplate } from '@documenso/email/templates/revalle-gate-locked';
import { prisma } from '@documenso/prisma';
import { createElement } from 'react';

import { NEXT_PUBLIC_WEBAPP_URL } from '../../../constants/app';
import { env } from '../../../utils/env';
import { logger } from '../../../utils/logger';
import { renderEmailWithI18N } from '../../../utils/render-email-with-i18n';
import { getEmailContext } from '../../email/get-email-context';

export const notifyRevalleGateLocked = async ({
  recipientId,
  reason,
}: {
  recipientId: number;
  reason: 'ATTEMPTS' | 'CPF_CONFLICT';
}): Promise<void> => {
  const recipient = await prisma.recipient.findUniqueOrThrow({
    where: { id: recipientId },
    select: {
      email: true,
      envelope: {
        select: {
          title: true,
          teamId: true,
          documentMeta: true,
          user: { select: { email: true, name: true } },
        },
      },
    },
  });

  const { envelope } = recipient;
  const adminEmail = env('NEXT_PRIVATE_REVALLE_ADMIN_EMAIL')?.trim();
  const targets = [{ name: envelope.user.name ?? '', address: envelope.user.email }];

  if (adminEmail && adminEmail.toLowerCase() !== envelope.user.email.toLowerCase()) {
    targets.push({ name: '', address: adminEmail });
  }

  const { branding, emailLanguage, senderEmail, emailsDisabled, emailTransport } = await getEmailContext({
    emailType: 'INTERNAL',
    source: { type: 'team', teamId: envelope.teamId },
    meta: envelope.documentMeta,
  });

  if (emailsDisabled) {
    return;
  }

  const template = createElement(RevalleGateLockedTemplate, {
    documentName: envelope.title,
    recipientEmail: recipient.email,
    reason,
    assetBaseUrl: NEXT_PUBLIC_WEBAPP_URL(),
  });

  const [html, text] = await Promise.all([
    renderEmailWithI18N(template, { lang: emailLanguage, branding }),
    renderEmailWithI18N(template, { lang: emailLanguage, branding, plainText: true }),
  ]);

  for (const to of targets) {
    try {
      await emailTransport.sendMail({
        to,
        from: senderEmail,
        subject: `Link de assinatura bloqueado — ${envelope.title}`,
        html,
        text,
      });
    } catch (error) {
      logger.error({ msg: '[RevSign] falha ao enviar aviso de bloqueio', recipientId, error: String(error) });
    }
  }
};
