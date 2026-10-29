// No upstream, 0 em teamCount/memberCount/recipientCount significa ilimitado.
export const REVALLE_CLAIM_LIMITS = {
  teamCount: 0,
  memberCount: 0,
  recipientCount: 0,
};

export const mergeRevalleClaimFlags = (flags: Record<string, unknown>): Record<string, unknown> => {
  return {
    ...flags,
    unlimitedDocuments: true,
    allowCustomBranding: true,
    hidePoweredBy: true,
  };
};
