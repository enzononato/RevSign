import { describe, expect, it } from 'vitest';

import { resolveRevalleIdentityPolicy, revalleIdentityAsksCpfEveryTime } from './identity-policy';

describe('resolveRevalleIdentityPolicy', () => {
  it('company e-mail uses the e-mail link', () => {
    expect(resolveRevalleIdentityPolicy({ isExternalEmail: false, termoCpf: null })).toEqual({ mode: 'LINKED_EMAIL' });
  });

  it('external e-mail always asks for CPF, with any CPF from the HR base', () => {
    expect(resolveRevalleIdentityPolicy({ isExternalEmail: true, termoCpf: null })).toEqual({
      mode: 'ALWAYS_CPF',
      reason: 'EXTERNAL_EMAIL',
      expectedCpf: null,
    });
  });

  it('Patrimônio termo always asks for CPF and only accepts the termo CPF, whatever the e-mail', () => {
    for (const isExternalEmail of [true, false]) {
      expect(resolveRevalleIdentityPolicy({ isExternalEmail, termoCpf: '52871936455' })).toEqual({
        mode: 'ALWAYS_CPF',
        reason: 'PATRIMONIO_TERMO',
        expectedCpf: '52871936455',
      });
    }
  });

  it('v.21 collaborator contract: company e-mail keeps the e-mail checks but asks for CPF every time', () => {
    const policy = resolveRevalleIdentityPolicy({
      isExternalEmail: false,
      termoCpf: null,
      isCollaboratorContract: true,
    });

    expect(policy).toEqual({ mode: 'LINKED_EMAIL', askCpfEveryTime: true });
    expect(revalleIdentityAsksCpfEveryTime(policy)).toBe(true);
    expect(
      revalleIdentityAsksCpfEveryTime(resolveRevalleIdentityPolicy({ isExternalEmail: false, termoCpf: null })),
    ).toBe(false);
    expect(
      resolveRevalleIdentityPolicy({ isExternalEmail: true, termoCpf: null, isCollaboratorContract: true }).mode,
    ).toBe('ALWAYS_CPF');
  });
});
