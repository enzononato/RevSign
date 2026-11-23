import { DocumentInviteEmailTemplate } from '@documenso/email/templates/document-invite';
import { resolveExpiresAt } from '@documenso/lib/constants/envelope-expiration';
import { RECIPIENT_ROLE_TO_EMAIL_TYPE, RECIPIENT_ROLES_DESCRIPTION } from '@documenso/lib/constants/recipient-roles';
import { AppError } from '@documenso/lib/errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import type { ApiRequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import { createDocumentAuditLogData } from '@documenso/lib/utils/document-audit-logs';
import { renderCustomEmailTemplate } from '@documenso/lib/utils/render-custom-email-template';
import { prisma } from '@documenso/prisma';
import { msg } from '@lingui/core/macro';
import {
  DocumentStatus,
  EnvelopeType,
  OrganisationType,
  RecipientRole,
  SendStatus,
  SigningStatus,
  WebhookTriggerEvents,
} from '@prisma/client';
import { createElement } from 'react';

import { getI18nInstance } from '../../client-only/providers/i18n-server';
import { NEXT_PUBLIC_WEBAPP_URL } from '../../constants/app';
import { revalleInviteReplyTo, revalleInviteSubject, revalleReminderSubject } from '../../revalle/invite-email'; // REVALLE:
import { greetingName } from '../../revalle/recipient-name'; // REVALLE:
import { extractDerivedDocumentEmailSettings } from '../../types/document-email';
import { mapEnvelopeToWebhookDocumentPayload, ZWebhookDocumentSchema } from '../../types/webhook-payload';
import { isDocumentCompleted } from '../../utils/document';
import type { EnvelopeIdOptions } from '../../utils/envelope';
import { isRecipientEmailValidForSending } from '../../utils/recipients';
import { renderEmailWithI18N } from '../../utils/render-email-with-i18n';
import { shouldShowNewAccountWarning } from '../../utils/sender-trust';
import { buildEnvelopeEmailHeaders } from '../email/build-envelope-email-headers';
import { getEmailContext } from '../email/get-email-context';
import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';
import { assertOrganisationRatesAndLimits } from '../rate-limit/assert-organisation-rates-and-limits';
import { updateRecipientNextReminder } from '../recipient/update-recipient-next-reminder';
import { findCollaboratorContractEmailSender } from '../revalle/collaborator-contract/sender'; // REVALLE:
import { assertNotPatrimonioTermo } from '../revalle/patrimonio/guard'; // REVALLE:
import { computeReceiptDocuments, recordSendReceiptSafely } from '../revalle/receipts/record-send-receipt'; // REVALLE:
import { assertUserNotDisabled } from '../user/assert-user-not-disabled';
import { triggerWebhook } from '../webhooks/trigger/trigger-webhook';

export type ResendDocumentOptions = {
  id: EnvelopeIdOptions;
  userId: number;
  recipients: number[];
  teamId: number;
  requestMetadata: ApiRequestMetadata;
  /** REVALLE: reenvio de termo do Patrimônio. Só a integração passa `true`; a tela e a API comum são recusadas. */
  revalleAllowPatrimonioTermo?: boolean;
};

export const resendDocument = async ({
  id,
  userId,
  recipients,
  teamId,
  requestMetadata,
  revalleAllowPatrimonioTermo = false, // REVALLE:
}: ResendDocumentOptions) => {
  const user = await prisma.user.findFirstOrThrow({
    where: {
      id: userId,
    },
    select: {
      id: true,
      email: true,
      name: true,
      disabled: true,
      createdAt: true,
    },
  });

  // Refuse to resend on behalf of a disabled account. Guards
  // document.redistribute / envelope.redistribute and the API v1 equivalent.
  assertUserNotDisabled(user);

  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id,
    type: EnvelopeType.DOCUMENT,
    userId,
    teamId,
  });

  const envelope = await prisma.envelope.findUnique({
    where: envelopeWhereInput,
    include: {
      recipients: true,
      documentMeta: true,
      team: {
        select: {
          teamEmail: true,
          name: true,
          organisation: {
            select: {
              organisationClaim: {
                select: {
                  recipientCount: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!envelope) {
    throw new Error('Document not found');
  }

  // REVALLE: termo do Patrimônio só é reenviado pela integração (um termo vencido continua vencido).
  if (!revalleAllowPatrimonioTermo) {
    await assertNotPatrimonioTermo(envelope.id);
  }

  if (envelope.recipients.length === 0) {
    throw new Error('Document has no recipients');
  }

  if (envelope.status === DocumentStatus.DRAFT) {
    throw new Error('Can not send draft document');
  }

  if (isDocumentCompleted(envelope.status)) {
    throw new Error('Can not send completed document');
  }

  // A recipientCount of 0 means unlimited recipients are allowed. Block resending
  // when the document has more recipients than the organisation is allowed to send
  // to, mirroring the check in `sendDocument`. This prevents bypassing the limit by
  // adding recipients to an already-sent document and then resending.
  const maximumRecipientCount = envelope.team.organisation.organisationClaim.recipientCount;

  if (maximumRecipientCount > 0 && envelope.recipients.length > maximumRecipientCount) {
    throw new AppError('RECIPIENT_LIMIT_EXCEEDED', {
      message: `You cannot send a document with more than ${maximumRecipientCount} recipients`,
      statusCode: 400,
    });
  }

  const expiresAt = resolveExpiresAt(envelope.documentMeta?.envelopeExpirationPeriod ?? null);

  const recipientsToRemind = envelope.recipients.filter(
    (recipient) =>
      recipients.includes(recipient.id) &&
      recipient.signingStatus === SigningStatus.NOT_SIGNED &&
      recipient.role !== RecipientRole.CC,
  );

  if (expiresAt && recipientsToRemind.length > 0) {
    await prisma.recipient.updateMany({
      where: {
        id: {
          in: recipientsToRemind.map((r) => r.id),
        },
      },
      data: {
        expiresAt,
        expirationNotifiedAt: null,
      },
    });
  }

  // A manual resend restarts the reminder cycle from scratch, mirroring the
  // initial send, so a recipient that hit the threshold can be reminded again.
  const resentAt = new Date();

  await Promise.all(
    recipientsToRemind.map((recipient) =>
      updateRecipientNextReminder({
        recipientId: recipient.id,
        envelopeId: envelope.id,
        sentAt: resentAt,
        lastReminderSentAt: null,
        resetReminderCount: true,
      }),
    ),
  );

  const isRecipientSigningRequestEmailEnabled = extractDerivedDocumentEmailSettings(
    envelope.documentMeta,
  ).recipientSigningRequest;

  if (!isRecipientSigningRequestEmailEnabled) {
    return envelope;
  }

  // REVALLE: v.22, contrato para colaboradores: o remetente fixo e a resposta para quem criou o contrato.
  const revalleContractSender = await findCollaboratorContractEmailSender(envelope.id);

  const {
    branding,
    emailLanguage,
    settings,
    organisationType,
    senderEmail,
    replyToEmail,
    organisationId,
    claims,
    emailsDisabled,
    emailTransport,
  } = await getEmailContext({
    emailType: 'RECIPIENT',
    source: {
      type: 'team',
      teamId: envelope.teamId,
    },
    meta: envelope.documentMeta,
  });

  // Don't resend any emails if the organisation has email sending disabled.
  if (user.disabled || emailsDisabled) {
    return envelope;
  }

  // Assert that there is enough quota to send the emails.
  await assertOrganisationRatesAndLimits({
    organisationId,
    organisationClaim: claims,
    count: recipientsToRemind.length,
    type: 'email',
  });

  // REVALLE: os SHA-256 dos arquivos originais, calculados uma vez para todos os comprovantes deste reenvio. Se falhar
  // aqui, cada comprovante calcula de novo (`undefined` = calcular).
  const receiptDocuments = computeReceiptDocuments(envelope.id).catch(() => undefined);

  const isNewAccountSender = shouldShowNewAccountWarning({
    userCreatedAt: user.createdAt,
    organisationClaim: claims,
  });

  await Promise.all(
    recipientsToRemind.map(async (recipient) => {
      if (recipient.role === RecipientRole.CC || !isRecipientEmailValidForSending(recipient)) {
        return;
      }

      const i18n = await getI18nInstance(emailLanguage);

      const recipientEmailType = RECIPIENT_ROLE_TO_EMAIL_TYPE[recipient.role];

      const { email, name } = recipient;
      const selfSigner = email === user.email;

      const recipientActionVerb = i18n._(RECIPIENT_ROLES_DESCRIPTION[recipient.role].actionVerb).toLowerCase();

      let emailMessage = envelope.documentMeta.message || '';
      let emailSubject = i18n._(msg`Reminder: Please ${recipientActionVerb} this document`);

      if (selfSigner) {
        emailMessage = i18n._(
          msg`You have initiated the document ${`"${envelope.title}"`} that requires you to ${recipientActionVerb} it.`,
        );
        emailSubject = i18n._(msg`Reminder: Please ${recipientActionVerb} your document`);
      }

      if (organisationType === OrganisationType.ORGANISATION) {
        emailSubject = i18n._(msg`Reminder: ${envelope.team.name} invited you to ${recipientActionVerb} a document`);

        if (!emailMessage) {
          const inviterName = user.name || user.email;

          emailMessage = i18n._(
            settings.includeSenderDetails
              ? msg`${inviterName} on behalf of "${envelope.team.name}" has invited you to ${recipientActionVerb} the document "${envelope.title}".`
              : msg`${envelope.team.name} has invited you to ${recipientActionVerb} the document "${envelope.title}".`,
          );
        }
      }

      // REVALLE: envio simplificado: o mesmo assunto padrão do convite (quem reenviou, ou o time), com "Lembrete: ".
      emailSubject = i18n._(
        revalleReminderSubject(
          i18n._(
            revalleInviteSubject({
              role: recipient.role,
              senderName: revalleContractSender?.senderName ?? user.name, // REVALLE:
              teamName: envelope.team.name,
              documentTitle: envelope.title,
            }),
          ),
        ),
      );

      const customEmailTemplate = {
        'signer.name': greetingName(name, email), // REVALLE: sem nome ainda, o e-mail
        'signer.email': email,
        'document.name': envelope.title,
      };

      const assetBaseUrl = NEXT_PUBLIC_WEBAPP_URL() || 'http://localhost:3000';
      const signDocumentLink = `${NEXT_PUBLIC_WEBAPP_URL()}/sign/${recipient.token}`;
      const reportUrl = `${NEXT_PUBLIC_WEBAPP_URL()}/report/${recipient.token}`;

      const template = createElement(DocumentInviteEmailTemplate, {
        documentName: envelope.title,
        inviterName: revalleContractSender?.senderName ?? (user.name || undefined), // REVALLE: remetente fixo (v.22)
        revalleHideInviterEmail: revalleContractSender !== null, // REVALLE: só o nome do remetente fixo
        inviterEmail:
          organisationType === OrganisationType.ORGANISATION
            ? envelope.team?.teamEmail?.email || user.email
            : user.email,
        assetBaseUrl,
        signDocumentLink,
        customBody: renderCustomEmailTemplate(emailMessage, customEmailTemplate),
        role: recipient.role,
        selfSigner,
        organisationType,
        teamName: envelope.team?.name,
        includeSenderDetails: settings.includeSenderDetails,
        reportUrl,
        // REVALLE: contrato para colaboradores (v.22): o e-mail do admin nunca aparece no convite.
        newAccountWarningSenderEmail:
          isNewAccountSender && !selfSigner && revalleContractSender === null ? user.email : undefined,
      });

      const [html, text] = await Promise.all([
        renderEmailWithI18N(template, {
          lang: emailLanguage,
          branding,
        }),
        renderEmailWithI18N(template, {
          lang: emailLanguage,
          branding,
          plainText: true,
        }),
      ]);

      // Send email outside any transaction to avoid holding a connection
      // open during network I/O.
      await emailTransport.sendMail({
        to: {
          address: email,
          name,
        },
        from: senderEmail,
        // REVALLE: sem resposta configurada, quem reenviou; contrato para colaboradores (v.22), quem criou o contrato.
        replyTo: revalleContractSender?.replyTo ?? revalleInviteReplyTo(replyToEmail, user.email),
        subject: envelope.documentMeta.subject
          ? renderCustomEmailTemplate(i18n._(msg`Reminder: ${envelope.documentMeta.subject}`), customEmailTemplate)
          : emailSubject,
        html,
        text,
        headers: buildEnvelopeEmailHeaders({
          userId: envelope.userId,
          envelopeId: envelope.id,
          teamId: envelope.teamId,
        }),
      });

      // REVALLE: comprovante de envio, só depois que o servidor de e-mail aceitou a mensagem (o reenvio não falha por ele).
      await recordSendReceiptSafely({
        envelopeId: envelope.id,
        recipient: { id: recipient.id, name: recipient.name, email: recipient.email, role: recipient.role },
        kind: 'RESEND',
        metadata: requestMetadata,
        documents: await receiptDocuments,
      });

      // Mark the recipient as sent if they were not already sent.
      await prisma.recipient.updateMany({
        where: {
          id: recipient.id,
          sendStatus: SendStatus.NOT_SENT,
        },
        data: {
          sendStatus: SendStatus.SENT,
          sentAt: new Date(),
        },
      });

      await prisma.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.EMAIL_SENT,
          envelopeId: envelope.id,
          metadata: requestMetadata,
          data: {
            emailType: recipientEmailType,
            recipientEmail: recipient.email,
            recipientName: recipient.name,
            recipientRole: recipient.role,
            recipientId: recipient.id,
            isResending: true,
          },
        }),
      });
    }),
  );

  await triggerWebhook({
    event: WebhookTriggerEvents.DOCUMENT_REMINDER_SENT,
    data: ZWebhookDocumentSchema.parse(mapEnvelopeToWebhookDocumentPayload(envelope)),
    userId: envelope.userId,
    teamId: envelope.teamId,
  });

  return envelope;
};
