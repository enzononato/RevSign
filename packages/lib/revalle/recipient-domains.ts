import { DIRECT_TEMPLATE_RECIPIENT_EMAIL } from '../constants/direct-templates';
import { env } from '../utils/env';
import { isEmailDomainAllowed, normalizeEmail } from './email-domain';

// Placeholder de destinatário de modelo (`recipient.1@documenso.com`), ancorado: `x.recipient.1@documenso.com.evil.example` não vale.
const TEMPLATE_PLACEHOLDER_EMAIL = /^recipient\.\d+@documenso\.com$/;

/** Placeholder de modelo ou o destinatário do link direto: nunca é uma pessoa de verdade. */
export const isTemplatePlaceholderEmail = (email: string | null | undefined): boolean => {
  if (!email || email.trim() === '') {
    return false;
  }

  const normalized = normalizeEmail(email);

  return TEMPLATE_PLACEHOLDER_EMAIL.test(normalized) || normalized === DIRECT_TEMPLATE_RECIPIENT_EMAIL;
};

/**
 * E-mails de rascunho de modelo que não são de uma pessoa: vazio, placeholder de modelo e o destinatário do link direto.
 * Só valem nos caminhos de criação/edição de MODELO; documento, envio e conclusão recusam o placeholder.
 */
export const isTemplateDraftEmailExempt = (email: string | null | undefined): boolean =>
  !email || email.trim() === '' || isTemplatePlaceholderEmail(email);

export const formatDomainList = (domains: string[]): string => {
  const list = domains.map((domain) => `@${domain}`);

  return list.length > 1 ? `${list.slice(0, -1).join(', ')} ou ${list[list.length - 1]}` : list.join('');
};

/** Domínios da empresa no navegador (vêm de NEXT_PUBLIC_REVALLE_ALLOWED_DOMAINS, derivada no servidor). */
export const getClientAllowedDomains = (): string[] =>
  (env('NEXT_PUBLIC_REVALLE_ALLOWED_DOMAINS') ?? '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);

/**
 * E-mail de fora da empresa (pessoal ou de outra empresa). Sem lista de domínios (instalação sem a regra), nada é
 * externo; e-mail vazio também não.
 */
export const isExternalEmail = (email: string | null | undefined, domains: string[]): boolean =>
  !!email && email.trim() !== '' && !isEmailDomainAllowed(email, domains);

/** O primeiro e-mail de fora da empresa da lista (como foi digitado, sem espaços nas pontas), ou null. */
export const findExternalEmail = (emails: Array<string | null | undefined>, domains: string[]): string | null => {
  const found = emails.find((email) => isExternalEmail(email, domains));

  return found ? found.trim() : null;
};

/** Recusa de nota fiscal com destinatário de fora (servidor e tela usam o mesmo texto). */
export const formatInvoiceExternalRecipientMessage = (email: string, domains: string[]): string =>
  `Nota fiscal só pode ser enviada para e-mails da empresa (${formatDomainList(domains)}). Troque o e-mail de ${email}.`;
