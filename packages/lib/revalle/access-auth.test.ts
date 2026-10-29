import { describe, expect, it } from 'vitest';

import { withRevalleAccessAuth, withRevalleRecipientAccessAuth } from './access-auth';

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

describe('withRevalleRecipientAccessAuth', () => {
  it('leaves an empty access auth alone (the document one applies)', () => {
    expect(withRevalleRecipientAccessAuth({ accessAuth: [], actionAuth: [] })).toEqual({
      accessAuth: [],
      actionAuth: [],
    });
  });

  it('appends the e-mail code to a non-empty list without it', () => {
    expect(withRevalleRecipientAccessAuth({ accessAuth: ['ACCOUNT'], actionAuth: ['PASSWORD'] })).toEqual({
      accessAuth: ['ACCOUNT', 'TWO_FACTOR_AUTH'],
      actionAuth: ['PASSWORD'],
    });
  });

  it('is idempotent', () => {
    const once = withRevalleRecipientAccessAuth({ accessAuth: ['ACCOUNT'], actionAuth: [] });

    expect(withRevalleRecipientAccessAuth(once)).toEqual(once);
  });
});
