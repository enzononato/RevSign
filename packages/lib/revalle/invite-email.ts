import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { RecipientRole } from '@prisma/client';

// Envio simplificado (17/11/2026): a tela não pede mais assunto nem e-mail para resposta. Sem eles, o convite usa os
// padrões daqui. Quem grava `subject`/`emailReplyTo` (documento antigo, API, time ou organização) continua valendo.

type InviteSubjectInput = {
  role: RecipientRole;
  senderName?: string | null;
  teamName?: string | null;
  documentTitle: string;
};

/** Assunto padrão do convite: `{quem enviou} enviou "{título}" para você {assinar|aprovar|ver|preencher}`. */
export const revalleInviteSubject = ({
  role,
  senderName,
  teamName,
  documentTitle,
}: InviteSubjectInput): MessageDescriptor => {
  // Sem o nome de quem enviou, o do time.
  const sender = senderName?.trim() || teamName?.trim() || 'RevSign';

  switch (role) {
    case RecipientRole.APPROVER:
      return msg`${sender} enviou "${documentTitle}" para você aprovar`;
    case RecipientRole.VIEWER:
      return msg`${sender} enviou "${documentTitle}" para você ver`;
    case RecipientRole.ASSISTANT:
      return msg`${sender} enviou "${documentTitle}" para você preencher`;
    default:
      return msg`${sender} enviou "${documentTitle}" para você assinar`;
  }
};

/** Assunto do reenvio e do lembrete automático: `Lembrete: ` + o assunto (o gravado no documento ou o padrão). */
export const revalleReminderSubject = (subject: string): MessageDescriptor => msg`Lembrete: ${subject}`;

/** Resposta ao convite: a configurada (documento, time ou organização); sem nenhuma, o e-mail de quem enviou. */
export const revalleInviteReplyTo = (
  configured: string | null | undefined,
  senderEmail: string | null | undefined,
): string | undefined => configured || senderEmail || undefined;
