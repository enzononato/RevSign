import { getAllowedSignupDomains } from '../../constants/auth';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { isEmailDomainAllowed } from '../../revalle/email-domain';
import { formatDomainList, isRecipientEmailExempt } from '../../revalle/recipient-domains';

export const assertRecipientEmailsAllowed = (
  emails: Array<string | null | undefined>,
  options: { rejectEmpty?: boolean } = {},
): void => {
  const allowedDomains = getAllowedSignupDomains();

  for (const email of emails) {
    if (options.rejectEmpty && (!email || email.trim() === '')) {
      throw new AppError(AppErrorCode.INVALID_BODY, {
        message: 'Todo destinatário precisa de um e-mail da empresa.',
      });
    }

    if (!email || isRecipientEmailExempt(email)) {
      continue;
    }

    if (!isEmailDomainAllowed(email, allowedDomains)) {
      throw new AppError(AppErrorCode.INVALID_BODY, {
        message: `O e-mail ${email.trim()} não é de um domínio da empresa. Use um e-mail ${formatDomainList(allowedDomains)}.`,
      });
    }
  }
};
