import type { RecipientRole, SigningStatus } from '@prisma/client';

export const REVALLE_MAX_ATTEMPTS = 5;

export type RevalleGateState =
  | { status: 'PASSED' }
  | { status: 'TERM_REQUIRED'; termVersion: string; termText: string; termNotice: string }
  | { status: 'IDENTITY_REQUIRED'; attemptsLeft: number }
  | { status: 'IDENTITY_CONFIRM'; preview: { primeiroNome: string; cargo: string | null; unidade: string | null } }
  | { status: 'LOCKED' }
  | { status: 'UNAVAILABLE' };

export type RevalleGateRecipient = {
  id: number;
  email: string;
  role: RecipientRole;
  signingStatus: SigningStatus;
};
