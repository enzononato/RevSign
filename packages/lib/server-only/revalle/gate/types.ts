import type { RecipientRole, SigningStatus } from '@prisma/client';

export const REVALLE_MAX_ATTEMPTS = 5;

export type RevalleGateState =
  | { status: 'PASSED' }
  | { status: 'TERM_REQUIRED'; termVersion: string; termText: string; termNotice: string }
  | { status: 'IDENTITY_REQUIRED'; attemptsLeft: number }
  | { status: 'IDENTITY_CONFIRM'; preview: { primeiroNome: string; cargo: string | null; unidade: string | null } }
  | { status: 'LOCKED' }
  | { status: 'UNAVAILABLE' }
  /** Fase 6: versão de NF substituída pelo Financeiro (conta trocada); nenhuma ação vale mais nela. */
  | { status: 'SUPERSEDED' };

export type RevalleGateRecipient = {
  id: number;
  email: string;
  role: RecipientRole;
  signingStatus: SigningStatus;
};
