import { prisma } from '@documenso/prisma';

import { env } from '../../utils/env';
import { mergeRevalleClaimFlags, REVALLE_CLAIM_LIMITS } from './claim-defaults';

const toFlagsRecord = (flags: unknown): Record<string, unknown> => {
  if (typeof flags === 'object' && flags !== null && !Array.isArray(flags)) {
    return { ...flags };
  }

  return {};
};

const applyFreePlanDefaults = async () => {
  return await prisma.$transaction(async (tx) => {
    const subscriptionClaim = await tx.subscriptionClaim.findUnique({ where: { id: 'free' } });

    if (subscriptionClaim) {
      await tx.subscriptionClaim.update({
        where: { id: 'free' },
        data: {
          ...REVALLE_CLAIM_LIMITS,
          flags: mergeRevalleClaimFlags(toFlagsRecord(subscriptionClaim.flags)),
        },
      });
    }

    const organisationClaims = await tx.organisationClaim.findMany({
      where: { originalSubscriptionClaimId: 'free' },
    });

    for (const organisationClaim of organisationClaims) {
      await tx.organisationClaim.update({
        where: { id: organisationClaim.id },
        data: {
          ...REVALLE_CLAIM_LIMITS,
          flags: mergeRevalleClaimFlags(toFlagsRecord(organisationClaim.flags)),
        },
      });
    }

    return { subscriptionClaimFound: Boolean(subscriptionClaim), organisationClaims: organisationClaims.length };
  });
};

const promoteMainAdmin = async (email: string) => {
  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, roles: true },
  });

  if (!user || user.roles.includes('ADMIN')) {
    return false;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { roles: { set: [...user.roles, 'ADMIN'] } },
  });

  return true;
};

export const runRevalleBootstrap = async () => {
  try {
    const result = await applyFreePlanDefaults();

    console.log(
      `[RevSign] bootstrap: plano free ${result.subscriptionClaimFound ? 'ajustado' : 'não encontrado'}, ${result.organisationClaims} organização(ões) ajustada(s)`,
    );

    const adminEmail = env('NEXT_PRIVATE_REVALLE_ADMIN_EMAIL');

    if (adminEmail) {
      const promoted = await promoteMainAdmin(adminEmail);

      console.log(`[RevSign] bootstrap: admin ${adminEmail} ${promoted ? 'promovido' : 'sem alteração'}`);
    }
  } catch (err) {
    console.error('[RevSign] bootstrap falhou', err);
  }
};
