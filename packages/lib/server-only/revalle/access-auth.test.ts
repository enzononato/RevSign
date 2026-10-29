import { describe, expect, it } from 'vitest';

import { withRevalleAccessAuth } from './access-auth';

describe('withRevalleAccessAuth', () => {
  it('adds the e-mail code requirement to empty options', () => {
    expect(withRevalleAccessAuth({ globalAccessAuth: [], globalActionAuth: [] })).toEqual({
      globalAccessAuth: ['TWO_FACTOR_AUTH'],
      globalActionAuth: [],
    });
  });

  it('keeps other methods and the action auth', () => {
    expect(withRevalleAccessAuth({ globalAccessAuth: ['ACCOUNT'], globalActionAuth: ['PASSWORD'] })).toEqual({
      globalAccessAuth: ['ACCOUNT', 'TWO_FACTOR_AUTH'],
      globalActionAuth: ['PASSWORD'],
    });
  });

  it('is idempotent', () => {
    const once = withRevalleAccessAuth({ globalAccessAuth: ['TWO_FACTOR_AUTH'], globalActionAuth: [] });

    expect(once.globalAccessAuth).toEqual(['TWO_FACTOR_AUTH']);
    expect(withRevalleAccessAuth(once)).toEqual(once);
  });
});
