import { getAllowedSignupDomains } from '../../constants/auth';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { isExternalEmail, isTemplatePlaceholderEmail } from '../../revalle/recipient-domains';

/**
 * Regra dos e-mails de destinatário (desde 16/11/2026, "e-mail externo"): documento comum vai para QUALQUER e-mail. O que
 * continua recusado:
 * - o placeholder de modelo (`recipient.N@documenso.com`) e o destinatário do link direto num DOCUMENTO, no envio e na
 *   conclusão: não são pessoas. `allowTemplatePlaceholders` só nos rascunhos de MODELO;
 * - e-mail vazio, com `rejectEmpty` (o envio recusa).
 * A nota fiscal continua só para e-mails da empresa: `invoice/external-recipients.ts`.
 */
export const assertRecipientEmailsAllowed = (
  emails: Array<string | null | undefined>,
  options: { rejectEmpty?: boolean; allowTemplatePlaceholders?: boolean } = {},
): void => {
  for (const email of emails) {
    if (!email || email.trim() === '') {
      if (options.rejectEmpty) {
        throw new AppError(AppErrorCode.INVALID_BODY, {
          message: 'Todo destinatário precisa de um e-mail.',
        });
      }

      continue;
    }

    if (!options.allowTemplatePlaceholders && isTemplatePlaceholderEmail(email)) {
      throw new AppError(AppErrorCode.INVALID_BODY, {
        message: `O e-mail ${email.trim()} é um exemplo do modelo, não de uma pessoa. Informe o e-mail de quem vai assinar.`,
      });
    }
  }
};

/** E-mail de fora dos domínios da empresa (`NEXT_PRIVATE_ALLOWED_SIGNUP_DOMAINS`). Sem a lista, nada é externo. */
export const isRevalleExternalEmail = (email: string | null | undefined): boolean =>
  isExternalEmail(email, getAllowedSignupDomains());
