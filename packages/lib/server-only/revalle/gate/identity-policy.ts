import type { RevalleIdentityPolicy } from '../../../revalle/identity-policy';
import { resolveRevalleIdentityPolicy } from '../../../revalle/identity-policy';
import { isRevalleExternalEmail } from '../assert-recipient-domains';
import { findCollaboratorContractRecipientCpf, isCollaboratorContractRecipient } from '../collaborator-contract/marker';
import { findPatrimonioSignerCpf } from '../patrimonio/gate';

export type { RevalleIdentityPolicy };

/** Regra de identidade do destinatário no portão (ver `revalle/identity-policy.ts`). */
export const getRevalleIdentityPolicy = async (recipient: {
  id: number;
  email: string;
}): Promise<RevalleIdentityPolicy> =>
  resolveRevalleIdentityPolicy({
    isExternalEmail: isRevalleExternalEmail(recipient.email),
    termoCpf: await findPatrimonioSignerCpf(recipient.id),
    isCollaboratorContract: await isCollaboratorContractRecipient(recipient.id),
    collaboratorCpf: await findCollaboratorContractRecipientCpf(recipient.id),
  });
