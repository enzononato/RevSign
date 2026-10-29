import { describe, expect, it } from 'vitest';

import { SUBSCRIPTION_CLAIM_FEATURE_FLAGS } from '../../types/subscription';
import { mergeRevalleClaimFlags } from './claim-defaults';

describe('mergeRevalleClaimFlags', () => {
  it('turns on the community branding/unlimited flags and keeps the rest', () => {
    expect(mergeRevalleClaimFlags({ embedSigning: true })).toEqual({
      embedSigning: true,
      unlimitedDocuments: true,
      allowCustomBranding: true,
      hidePoweredBy: true,
    });
  });

  it('never enables an enterprise flag', () => {
    const result = mergeRevalleClaimFlags({});

    for (const flag of Object.values(SUBSCRIPTION_CLAIM_FEATURE_FLAGS).filter((f) => f.isEnterprise)) {
      expect(result[flag.key]).not.toBe(true);
    }
  });

  it('is idempotent', () => {
    const once = mergeRevalleClaimFlags({ cfr21: false });

    expect(mergeRevalleClaimFlags(once)).toEqual(once);
  });
});
