import type { RecipientRole } from '@prisma/client';

// REVALLE: o mesmo verbo por papel no /verificar e no certificado.
const REVALLE_ROLE_VERBS: Partial<Record<RecipientRole, string>> = {
  SIGNER: 'Assinou em',
  APPROVER: 'Aprovou em',
  VIEWER: 'Visualizou em',
  ASSISTANT: 'Preencheu em',
};

export const revalleRoleVerb = (role: RecipientRole): string => REVALLE_ROLE_VERBS[role] ?? 'Assinou em';
