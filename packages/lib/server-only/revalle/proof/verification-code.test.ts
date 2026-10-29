import { describe, expect, it } from 'vitest';

import { generateVerificationCode, VERIFICATION_CODE_REGEX } from './verification-code';

describe('generateVerificationCode', () => {
  it('usa o formato XXXX-XXXX', () => {
    expect(generateVerificationCode()).toMatch(VERIFICATION_CODE_REGEX);
  });

  it('nunca usa caracteres ambíguos em 1.000 códigos', () => {
    for (let i = 0; i < 1000; i++) {
      expect(generateVerificationCode()).not.toMatch(/[01ILO]/);
    }
  });
});
