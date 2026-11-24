import { RECIPIENT_ROLES_DESCRIPTION } from '@documenso/lib/constants/recipient-roles';
import { REVALLE_APP_NAME } from '@documenso/lib/revalle/brand'; // REVALLE:
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import type { RecipientRole } from '@prisma/client';
import { OrganisationType } from '@prisma/client';

// REVALLE: convite em formato de carta (24/11/2026), sem logo, sem imagem e sem cartão: marca em texto, "Olá, {nome},",
// uma frase com quem enviou o quê, a mensagem de quem enviou, botão discreto + endereço por extenso, "Atenciosamente".
// Mesmas informações e variações de antes (próprio documento, organização, remetente fixo do contrato).
import {
  RevalleActionButton,
  RevalleLetter,
  RevalleLetterOpening,
  RevalleSignOff,
  revalleRoleVerb,
} from '../template-components/revalle-letter';
import type { TemplateDocumentInviteProps } from '../template-components/template-document-invite';
import { TemplateNewAccountWarning } from '../template-components/template-new-account-warning';

export type DocumentInviteEmailTemplateProps = Partial<TemplateDocumentInviteProps> & {
  customBody?: string;
  role: RecipientRole;
  selfSigner?: boolean;
  teamName?: string;
  teamEmail?: string;
  includeSenderDetails?: boolean;
  organisationType?: OrganisationType;
  reportUrl?: string;

  /**
   * The user's own email, not a team email, so the recipient can verify who
   * actually contacted them.
   */
  newAccountWarningSenderEmail?: string;

  /** REVALLE: v.22, contrato para colaboradores: só o nome do remetente fixo, sem o e-mail de quem criou. */
  revalleHideInviterEmail?: boolean;

  /** REVALLE: nome de quem recebe, para "Olá, {nome},"; vazio, só "Olá,". */
  recipientName?: string;
};

export const DocumentInviteEmailTemplate = ({
  inviterName = '', // REVALLE: sem nome, o e-mail de quem enviou (nunca o "Lucas Smith" do exemplo do upstream)
  inviterEmail = 'lucas@documenso.com',
  documentName = 'Open Source Pledge.pdf',
  signDocumentLink = 'https://documenso.com',
  customBody,
  role,
  selfSigner = false,
  teamName = '',
  includeSenderDetails,
  organisationType,
  reportUrl,
  newAccountWarningSenderEmail,
  revalleHideInviterEmail = false, // REVALLE:
  recipientName = '', // REVALLE:
}: DocumentInviteEmailTemplateProps) => {
  const { _ } = useLingui();

  const action = _(RECIPIENT_ROLES_DESCRIPTION[role].actionVerb).toLowerCase();

  let previewText = msg`${inviterName} has invited you to ${action} ${documentName}`;

  if (organisationType === OrganisationType.ORGANISATION) {
    previewText = includeSenderDetails
      ? msg`${inviterName} on behalf of "${teamName}" has invited you to ${action} ${documentName}`
      : msg`${teamName} has invited you to ${action} ${documentName}`;
  }

  if (selfSigner) {
    previewText = msg`Please ${action} your document ${documentName}`;
  }

  // REVALLE: a frase do convite e a assinatura da carta, com as mesmas variações da frase grande do upstream.
  const verb = _(revalleRoleVerb(role));
  const personName = inviterName.trim() || inviterEmail;
  const isOrganisation = organisationType === OrganisationType.ORGANISATION && Boolean(teamName);
  const onBehalfOfTeam = isOrganisation && includeSenderDetails;

  let sender = personName;
  let sentence = msg`${sender} enviou o documento "${documentName}" para você ${verb}.`;
  let signOff: { name: string; detail?: string | null } = {
    name: personName,
    detail: revalleHideInviterEmail || !inviterName.trim() ? null : inviterEmail,
  };

  if (isOrganisation && !onBehalfOfTeam) {
    sender = teamName;
    sentence = msg`${sender} enviou o documento "${documentName}" para você ${verb}.`;
    signOff = { name: teamName };
  }

  if (onBehalfOfTeam) {
    sentence = msg`${personName}, em nome de "${teamName}", enviou o documento "${documentName}" para você ${verb}.`;
    signOff = { name: personName, detail: teamName };
  }

  if (selfSigner) {
    sentence = msg`Seu documento "${documentName}" está pronto para você ${verb}.`;
    signOff = { name: REVALLE_APP_NAME };
  }

  return (
    <RevalleLetter preview={_(previewText)}>
      {newAccountWarningSenderEmail && (
        <TemplateNewAccountWarning senderEmail={newAccountWarningSenderEmail} reportUrl={reportUrl} />
      )}

      <RevalleLetterOpening recipientName={recipientName} sentence={_(sentence)} customBody={customBody} />

      <RevalleActionButton role={role} href={signDocumentLink} />

      <RevalleSignOff name={signOff.name} detail={signOff.detail} />
    </RevalleLetter>
  );
};

export default DocumentInviteEmailTemplate;
