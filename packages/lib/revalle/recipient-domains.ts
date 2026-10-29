import { DIRECT_TEMPLATE_RECIPIENT_EMAIL } from '../constants/direct-templates';
import { env } from '../utils/env';
import { isEmailDomainAllowed, normalizeEmail } from './email-domain';

// Placeholder de destinatário de modelo (`recipient.1@documenso.com`), ancorado: `x.recipient.1@documenso.com.evil.example` não vale.
const TEMPLATE_PLACEHOLDER_EMAIL = /^recipient\.\d+@documenso\.com$/;

/**
 * E-mails de rascunho de modelo que ficam fora da regra de domínio: vazio, placeholder de modelo e o destinatário do link direto.
 * Só vale nos caminhos de criação/edição de MODELO; documento, envio e conclusão usam a regra estrita.
 */
export const isTemplateDraftEmailExempt = (email: string | null | undefined): boolean => {
  if (!email || email.trim() === '') {
    return true;
  }

  const normalized = normalizeEmail(email);

  return TEMPLATE_PLACEHOLDER_EMAIL.test(normalized) || normalized === DIRECT_TEMPLATE_RECIPIENT_EMAIL;
};

export const formatDomainList = (domains: string[]): string => {
  const list = domains.map((domain) => `@${domain}`);

  return list.length > 1 ? `${list.slice(0, -1).join(', ')} ou ${list[list.length - 1]}` : list.join('');
};

/** Domínios permitidos no navegador (vêm de NEXT_PUBLIC_REVALLE_ALLOWED_DOMAINS, derivada no servidor). */
export const getClientAllowedDomains = (): string[] =>
  (env('NEXT_PUBLIC_REVALLE_ALLOWED_DOMAINS') ?? '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);

/** Retorna a mensagem de erro do formulário, ou undefined quando o e-mail pode ser usado (o servidor confere de novo). */
export const getRecipientDomainFormError = (email: string): string | undefined => {
  const domains = getClientAllowedDomains();

  if (isTemplateDraftEmailExempt(email) || isEmailDomainAllowed(email, domains)) {
    return undefined;
  }

  return `Use um e-mail da empresa (${formatDomainList(domains)}).`;
};

export const refineRecipientDomains = (
  data: { signers: Array<{ email: string }> },
  ctx: { addIssue: (issue: { code: 'custom'; message: string; path: Array<string | number> }) => void },
): void => {
  data.signers.forEach((signer, index) => {
    const message = getRecipientDomainFormError(signer.email);

    if (message) {
      ctx.addIssue({ code: 'custom', message, path: ['signers', index, 'email'] });
    }
  });
};
