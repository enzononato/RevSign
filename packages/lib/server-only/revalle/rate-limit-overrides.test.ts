import { describe, expect, it } from 'vitest';

import { resolveRateLimitOverrides } from './rate-limit-overrides';

describe('resolveRateLimitOverrides', () => {
  it('raises the upstream signup limit by default', () => {
    const { overrides, invalidEntries } = resolveRateLimitOverrides(undefined);

    expect(overrides['auth.signup']).toEqual({ max: 30, window: '1h' });
    expect(invalidEntries).toEqual([]);
  });

  it('sizes the defaults for a whole unit behind one IP', () => {
    const { overrides } = resolveRateLimitOverrides(undefined);

    expect(overrides['auth.request-2fa-email']).toEqual({ max: 5, globalMax: 200, window: '15m' });
    expect(overrides['auth.login']).toEqual({ max: 10, globalMax: 200, window: '15m' });
    expect(overrides['api.trpc']).toEqual({ max: 3000, window: '1m' });
    expect(overrides['api.file-upload']).toEqual({ max: 300, window: '1m' });
  });

  it('parses per-identifier and per-IP limits and lets the env override the default', () => {
    const { overrides } = resolveRateLimitOverrides(' auth.login=10:200/15m , auth.signup=50/2h ');

    expect(overrides['auth.login']).toEqual({ max: 10, globalMax: 200, window: '15m' });
    expect(overrides['auth.signup']).toEqual({ max: 50, window: '2h' });
  });

  it('ignores malformed and zero entries instead of disabling a limit', () => {
    const { overrides, invalidEntries } = resolveRateLimitOverrides(
      'auth.login=10/15x,auth.verify-email=0/15m,auth.forgot-password=3:0/1h,auth.passkey=5/0m,nonsense',
    );

    expect(invalidEntries).toEqual([
      'auth.login=10/15x',
      'auth.verify-email=0/15m',
      'auth.forgot-password=3:0/1h',
      'auth.passkey=5/0m',
      'nonsense',
    ]);
    expect(Object.keys(overrides).sort()).toEqual(
      ['api.file-upload', 'api.trpc', 'auth.login', 'auth.request-2fa-email', 'auth.signup'].sort(),
    );
  });
});
