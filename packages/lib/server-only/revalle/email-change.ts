import { normalizeEmail } from '../../revalle/email-domain';

/** O e-mail do destinatário mudou (ignorando caixa e espaços)? Nesse caso o token do link é trocado. */
export const hasRevalleEmailChanged = (previous: string, next: string | undefined): boolean =>
  next !== undefined && normalizeEmail(previous) !== normalizeEmail(next);
