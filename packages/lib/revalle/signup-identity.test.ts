import { describe, expect, it } from 'vitest';

import { formatBirthDateInput, formatCpfInput } from './input-masks';
import { isSignupIdentityFormValid } from './signup-identity';

describe('formatCpfInput', () => {
  it('adds the dots and the dash while the person types', () => {
    expect(formatCpfInput('1')).toBe('1');
    expect(formatCpfInput('1114')).toBe('111.4');
    expect(formatCpfInput('111444777')).toBe('111.444.777');
    expect(formatCpfInput('11144477735')).toBe('111.444.777-35');
  });

  it('drops letters and stops at 11 digits', () => {
    expect(formatCpfInput('111a444b777c35')).toBe('111.444.777-35');
    expect(formatCpfInput('1114447773599')).toBe('111.444.777-35');
  });

  it('keeps an already formatted value as it is', () => {
    expect(formatCpfInput('111.444.777-35')).toBe('111.444.777-35');
  });
});

describe('formatBirthDateInput', () => {
  it('adds the slashes while the person types', () => {
    expect(formatBirthDateInput('0')).toBe('0');
    expect(formatBirthDateInput('0302')).toBe('03/02');
    expect(formatBirthDateInput('03021991')).toBe('03/02/1991');
  });

  it('drops letters and stops at 8 digits', () => {
    expect(formatBirthDateInput('03/02/19911')).toBe('03/02/1991');
    expect(formatBirthDateInput('0a3b')).toBe('03');
  });
});

describe('isSignupIdentityFormValid', () => {
  it('accepts a valid CPF with or without mask and a real date', () => {
    expect(isSignupIdentityFormValid({ cpf: '111.444.777-35', birthDate: '03/02/1991' })).toBe(true);
    expect(isSignupIdentityFormValid({ cpf: '11144477735', birthDate: '3/2/1991' })).toBe(true);
  });

  it('rejects a CPF with the wrong check digits, repeated digits or the wrong size', () => {
    expect(isSignupIdentityFormValid({ cpf: '111.444.777-36', birthDate: '03/02/1991' })).toBe(false);
    expect(isSignupIdentityFormValid({ cpf: '111.111.111-11', birthDate: '03/02/1991' })).toBe(false);
    expect(isSignupIdentityFormValid({ cpf: '111.444.777', birthDate: '03/02/1991' })).toBe(false);
    expect(isSignupIdentityFormValid({ cpf: '', birthDate: '03/02/1991' })).toBe(false);
  });

  it('rejects a date that does not exist, is in the future or is incomplete', () => {
    expect(isSignupIdentityFormValid({ cpf: '111.444.777-35', birthDate: '31/02/1991' })).toBe(false);
    expect(isSignupIdentityFormValid({ cpf: '111.444.777-35', birthDate: '03/02/2999' })).toBe(false);
    expect(isSignupIdentityFormValid({ cpf: '111.444.777-35', birthDate: '03/02' })).toBe(false);
    expect(isSignupIdentityFormValid({ cpf: '111.444.777-35', birthDate: '' })).toBe(false);
  });
});
