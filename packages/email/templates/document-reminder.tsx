import { RECIPIENT_ROLES_DESCRIPTION } from '@documenso/lib/constants/recipient-roles';
import { REVALLE_APP_NAME } from '@documenso/lib/revalle/brand'; // REVALLE:
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { RecipientRole } from '@prisma/client';

// REVALLE: lembrete em formato de carta (24/11/2026), igual ao convite: marca em texto, "Olá, {nome},", a frase do
// lembrete, a mensagem de quem enviou, botão discreto + endereço por extenso e "Atenciosamente". Sem logo nem imagem.
import {
  RevalleActionButton,
  RevalleLetter,
  RevalleLetterOpening,
  RevalleSignOff,
  revalleRoleVerb,
} from '../template-components/revalle-letter';
import { TemplateNewAccountWarning } from '../template-components/template-new-account-warning';

export type DocumentReminderEmailTemplateProps = {
  recipientName: string;
  documentName: string;
  signDocumentLink: string;
  assetBaseUrl?: string;
  customBody?: string;
  role: RecipientRole;
  reportUrl?: string;
  newAccountWarningSenderEmail?: string;
  /** REVALLE: quem enviou (o remetente fixo do contrato, ou o dono do documento), para a frase e a assinatura. */
  inviterName?: string;
};

export const DocumentReminderEmailTemplate = ({
  recipientName = 'John Doe',
  documentName = 'Open Source Pledge.pdf',
  signDocumentLink = 'https://documenso.com',
  customBody,
  role = RecipientRole.SIGNER,
  reportUrl,
  newAccountWarningSenderEmail,
  inviterName = '', // REVALLE:
}: DocumentReminderEmailTemplateProps) => {
  const { _ } = useLingui();

  const action = _(RECIPIENT_ROLES_DESCRIPTION[role].actionVerb).toLowerCase();

  const previewText = msg`Reminder to ${action} ${documentName}`;

  // REVALLE: frase do lembrete com quem enviou; sem o nome, só o documento pendente.
  const verb = _(revalleRoleVerb(role));
  const sender = inviterName.trim();

  const sentence = sender
    ? msg`Lembrete: ${sender} enviou o documento "${documentName}" para você ${verb} e ele ainda está pendente.`
    : msg`Lembrete: o documento "${documentName}" ainda está pendente para você ${verb}.`;

  return (
    <RevalleLetter preview={_(previewText)}>
      {newAccountWarningSenderEmail && (
        <TemplateNewAccountWarning senderEmail={newAccountWarningSenderEmail} reportUrl={reportUrl} />
      )}

      <RevalleLetterOpening recipientName={recipientName} sentence={_(sentence)} customBody={customBody} />

      <RevalleActionButton role={role} href={signDocumentLink} />

      <RevalleSignOff name={sender || REVALLE_APP_NAME} />
    </RevalleLetter>
  );
};

export default DocumentReminderEmailTemplate;
