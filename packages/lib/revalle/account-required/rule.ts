import { isEmailDomainAllowed, normalizeEmail } from '../email-domain';

/**
 * Conta obrigatória para quem assina pelo e-mail da empresa (decisão de 16/11/2026).
 *
 * Quem tem e-mail de um domínio da empresa (`NEXT_PRIVATE_ALLOWED_SIGNUP_DOMAINS`) e ainda precisa agir no documento
 * (assinar, aprovar, recusar: todo papel menos CC e VIEWER, enquanto não concluiu) só age logado na conta do RevSign
 * desse mesmo e-mail. A regra vale pelo domínio, sem opção por documento, e também para os documentos enviados antes
 * dela. E-mail de fora da empresa continua sem conta (CPF + data de nascimento a cada documento).
 */

/** Sem sessão (ou sessão de conta sem e-mail confirmado): entrar ou criar a conta. HTTP 401. */
export const REVALLE_ACCOUNT_REQUIRED_CODE = 'REVALLE_ACCOUNT_REQUIRED';

/** Logado com outra conta: sair e entrar com a conta do destinatário. HTTP 403. */
export const REVALLE_ACCOUNT_MISMATCH_CODE = 'REVALLE_ACCOUNT_MISMATCH';

export const isRevalleAccountErrorCode = (code: unknown): boolean =>
  code === REVALLE_ACCOUNT_REQUIRED_CODE || code === REVALLE_ACCOUNT_MISMATCH_CODE;

export type RevalleAccountRecipient = {
  email: string;
  role: string;
  signingStatus: string;
};

const cleanDomains = (domains: string[]) => domains.map(normalizeEmail).filter((domain) => domain.length > 0);

/** E-mail de um domínio da empresa. Sem lista de domínios (instalação sem a regra), nenhum e-mail é da empresa. */
export const isRevalleCompanyEmail = (email: string | null | undefined, domains: string[]): boolean =>
  !!email && email.trim() !== '' && cleanDomains(domains).length > 0 && isEmailDomainAllowed(email, domains);

/** O destinatário precisa estar logado na conta do próprio e-mail para agir. */
export const isRevalleAccountRequired = (recipient: RevalleAccountRecipient, domains: string[]): boolean =>
  recipient.signingStatus === 'NOT_SIGNED' &&
  recipient.role !== 'CC' &&
  recipient.role !== 'VIEWER' &&
  isRevalleCompanyEmail(recipient.email, domains);

export const isSameEmail = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && normalizeEmail(a) === normalizeEmail(b);

export type RevalleAccountCheck =
  | { status: 'NOT_REQUIRED' }
  | { status: 'OK' }
  | { status: 'NO_SESSION' }
  | { status: 'WRONG_USER' };

/**
 * `sessionEmail`: e-mail da conta logada, só se a conta estiver confirmada e ativa (senão, null). A comparação ignora
 * maiúsculas e espaços nas pontas.
 */
export const checkRevalleAccount = ({
  recipient,
  domains,
  sessionEmail,
}: {
  recipient: RevalleAccountRecipient;
  domains: string[];
  sessionEmail: string | null | undefined;
}): RevalleAccountCheck => {
  if (!isRevalleAccountRequired(recipient, domains)) {
    return { status: 'NOT_REQUIRED' };
  }

  if (!sessionEmail) {
    return { status: 'NO_SESSION' };
  }

  return isSameEmail(sessionEmail, recipient.email) ? { status: 'OK' } : { status: 'WRONG_USER' };
};
