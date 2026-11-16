import { describe, expect, it } from 'vitest';

import { resolveRevalleIdentityPolicy } from './identity-policy';

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
});
