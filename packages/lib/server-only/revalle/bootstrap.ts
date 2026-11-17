import { prisma } from '@documenso/prisma';

import { env } from '../../utils/env';
import { mergeRevalleClaimFlags, REVALLE_CLAIM_LIMITS, revalleEnvelopeItemCount } from './claim-defaults';
import { checkRevalleGeoIpDatabase } from './geoip';
import { backfillLegacyInvoiceFiles } from './invoice/invoice-files';

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
          envelopeItemCount: revalleEnvelopeItemCount(subscriptionClaim.envelopeItemCount),
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
          envelopeItemCount: revalleEnvelopeItemCount(organisationClaim.envelopeItemCount),
          flags: mergeRevalleClaimFlags(toFlagsRecord(organisationClaim.flags)),
        },
      });
    }

    return { subscriptionClaimFound: Boolean(subscriptionClaim), organisationClaims: organisationClaims.length };
  });
};

type PromoteResult = 'promoted' | 'unchanged' | 'unverified';

const promoteMainAdmin = async (email: string): Promise<PromoteResult> => {
  // Só contas com e-mail confirmado podem virar ADMIN: evita que alguém registre
  // antes o e-mail do administrador e herde o papel.
  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' }, emailVerified: { not: null } },
    select: { id: true },
  });

  if (!user) {
    const unverified = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
    });

    return unverified ? 'unverified' : 'unchanged';
  }

  // Atômico: só acrescenta ADMIN se ainda não existir.
  const { count } = await prisma.user.updateMany({
    where: { id: user.id, NOT: { roles: { has: 'ADMIN' } } },
    data: { roles: { push: 'ADMIN' } },
  });

  return count > 0 ? 'promoted' : 'unchanged';
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

      if (promoted === 'unverified') {
        console.log('[RevSign] bootstrap: conta admin ainda não confirmada; confirme o e-mail e reinicie');
      } else {
        console.log(
          `[RevSign] bootstrap: admin ${adminEmail} ${promoted === 'promoted' ? 'promovido' : 'sem alteração'}`,
        );
      }
    }
  } catch (err) {
    console.error('[RevSign] bootstrap falhou', err);
  }

  // Fase 9: envio NF já enviado, de antes da Fase 9 e com mais de um arquivo, ganha as linhas por arquivo (a migração só
  // cria a dos envios de um arquivo). Falhar aqui não impede a subida: a primeira leitura do envio refaz.
  try {
    const rebuilt = await backfillLegacyInvoiceFiles();

    if (rebuilt > 0) {
      console.log(`[RevSign] bootstrap: ${rebuilt} nota(s) fiscal(is) antiga(s) com as linhas por arquivo refeitas`);
    }
  } catch (err) {
    console.error('[RevSign] bootstrap: falha ao refazer as linhas por arquivo das notas antigas', err);
  }

  // Fora do try acima: a base GeoIP não depende do banco. Base ausente ou vazia gera um aviso no log.
  await checkRevalleGeoIpDatabase().catch(() => undefined);
};
