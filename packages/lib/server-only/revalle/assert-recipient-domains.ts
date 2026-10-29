import { getAllowedSignupDomains } from '../../constants/auth';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { isEmailDomainAllowed } from '../../revalle/email-domain';
import { formatDomainList, isTemplateDraftEmailExempt } from '../../revalle/recipient-domains';

/**
 * Regra de domínio dos destinatários. Estrita por padrão (documento, envio, conclusão): nenhum e-mail fora dos domínios passa.
 * `allowTemplatePlaceholders` só nos rascunhos de MODELO (placeholder `recipient.N@documenso.com` e link direto).
 * E-mail vazio é ignorado, a não ser com `rejectEmpty` (o envio recusa).
 */
export const assertRecipientEmailsAllowed = (
  emails: Array<string | null | undefined>,
  options: { rejectEmpty?: boolean; allowTemplatePlaceholders?: boolean } = {},
): void => {
  const allowedDomains = getAllowedSignupDomains();

  for (const email of emails) {
    if (!email || email.trim() === '') {
      if (options.rejectEmpty) {
        throw new AppError(AppErrorCode.INVALID_BODY, {
          message: 'Todo destinatário precisa de um e-mail da empresa.',
        });
      }

      continue;
    }

    if (options.allowTemplatePlaceholders && isTemplateDraftEmailExempt(email)) {
      continue;
    }

    if (!isEmailDomainAllowed(email, allowedDomains)) {
      throw new AppError(AppErrorCode.INVALID_BODY, {
        message: `O e-mail ${email.trim()} não é de um domínio da empresa. Use um e-mail ${formatDomainList(allowedDomains)}.`,
      });
    }
  }
};
