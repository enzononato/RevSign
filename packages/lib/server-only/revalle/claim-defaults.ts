// No upstream, 0 em teamCount/memberCount/recipientCount significa ilimitado.
export const REVALLE_CLAIM_LIMITS = {
  teamCount: 0,
  memberCount: 0,
  recipientCount: 0,
};

// Fase 9: um envio pode ter várias notas, boletos e o contrato; o plano free do upstream deixa só 5 arquivos.
// É piso, não valor fixo: um limite maior posto pelo admin continua valendo depois do bootstrap.
export const REVALLE_MIN_ENVELOPE_ITEM_COUNT = 10;

export const revalleEnvelopeItemCount = (current: number) => Math.max(current, REVALLE_MIN_ENVELOPE_ITEM_COUNT);

export const mergeRevalleClaimFlags = (flags: Record<string, unknown>): Record<string, unknown> => {
  return {
    ...flags,
    unlimitedDocuments: true,
    allowCustomBranding: true,
    hidePoweredBy: true,
  };
};
