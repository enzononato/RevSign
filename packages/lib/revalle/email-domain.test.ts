import { describe, expect, it } from 'vitest';

import { isEmailDomainAllowed, normalizeEmail } from './email-domain';

describe('normalizeEmail', () => {
  it('trims and lowercases the address', () => {
    expect(normalizeEmail(' Fulano@Revalle.com.br ')).toBe('fulano@revalle.com.br');
  });
});

describe('isEmailDomainAllowed', () => {
  it('allows an address whose domain is in the list, regardless of case and spaces', () => {
    expect(isEmailDomainAllowed(' Fulano@Revalle.com.br ', ['revalle.com.br'])).toBe(true);
  });

  it('rejects a domain that only starts with an allowed one', () => {
    expect(isEmailDomainAllowed('a@revalle.com.br.evil.com', ['revalle.com.br'])).toBe(false);
  });

  it('rejects a subdomain of an allowed domain', () => {
    expect(isEmailDomainAllowed('a@x.revalle.com.br', ['revalle.com.br'])).toBe(false);
  });

  it('rejects a value without an @ even when it equals an allowed domain', () => {
    expect(isEmailDomainAllowed('revalle.com.br', ['revalle.com.br'])).toBe(false);
  });

  it('allows any domain when the list is empty', () => {
    expect(isEmailDomainAllowed('a@gmail.com', [])).toBe(true);
  });
});
