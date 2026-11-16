import { describe, expect, it } from 'vitest';

import {
  buildRevalleAccountPath,
  parseStoredSigningReturnTo,
  sanitizeSigningReturnTo,
  tokenOfSigningReturnTo,
} from './return-to';
import { checkRevalleAccount, isRevalleAccountRequired, isRevalleCompanyEmail, isSameEmail } from './rule';

const DOMAINS = ['revalle.com.br', 'revallenordeste.com.br', 'revallepe.com.br'];

const signer = (email: string, extra: Partial<{ role: string; signingStatus: string }> = {}) => ({
  email,
  role: 'SIGNER',
  signingStatus: 'NOT_SIGNED',
  ...extra,
});

describe('isRevalleCompanyEmail', () => {
  it('company domains, any case and spaces', () => {
    expect(isRevalleCompanyEmail('ana@revalle.com.br', DOMAINS)).toBe(true);
    expect(isRevalleCompanyEmail(' Ana@RevallePE.com.br ', DOMAINS)).toBe(true);
    expect(isRevalleCompanyEmail('ana@revallenordeste.com.br', DOMAINS)).toBe(true);
  });

  it('external, look-alike and empty e-mails are not company e-mails', () => {
    expect(isRevalleCompanyEmail('ana@gmail.com', DOMAINS)).toBe(false);
    expect(isRevalleCompanyEmail('ana@revalle.com.br.evil.example', DOMAINS)).toBe(false);
    expect(isRevalleCompanyEmail('ana@sub.revalle.com.br', DOMAINS)).toBe(false);
    expect(isRevalleCompanyEmail('', DOMAINS)).toBe(false);
    expect(isRevalleCompanyEmail(null, DOMAINS)).toBe(false);
  });

  it('without a domain list nothing is a company e-mail (the rule is off)', () => {
    expect(isRevalleCompanyEmail('ana@revalle.com.br', [])).toBe(false);
    expect(isRevalleCompanyEmail('ana@revalle.com.br', [' '])).toBe(false);
  });
});

describe('isRevalleAccountRequired', () => {
  it('signer, approver and assistant with a company e-mail who still have to act', () => {
    for (const role of ['SIGNER', 'APPROVER', 'ASSISTANT']) {
      expect(isRevalleAccountRequired(signer('ana@revalle.com.br', { role }), DOMAINS)).toBe(true);
    }
  });

  it('viewer and CC never need the account', () => {
    for (const role of ['VIEWER', 'CC']) {
      expect(isRevalleAccountRequired(signer('ana@revalle.com.br', { role }), DOMAINS)).toBe(false);
    }
  });

  it('after signing or rejecting, the link works as before', () => {
    for (const signingStatus of ['SIGNED', 'REJECTED']) {
      expect(isRevalleAccountRequired(signer('ana@revalle.com.br', { signingStatus }), DOMAINS)).toBe(false);
    }
  });

  it('external e-mail signs without an account', () => {
    expect(isRevalleAccountRequired(signer('ana@gmail.com'), DOMAINS)).toBe(false);
  });
});

describe('checkRevalleAccount', () => {
  const recipient = signer('Ana.Souza@revalle.com.br');

  it('no session', () => {
    expect(checkRevalleAccount({ recipient, domains: DOMAINS, sessionEmail: null })).toEqual({ status: 'NO_SESSION' });
  });

  it('same e-mail ignoring case', () => {
    expect(checkRevalleAccount({ recipient, domains: DOMAINS, sessionEmail: 'ana.souza@REVALLE.com.br' })).toEqual({
      status: 'OK',
    });
  });

  it('another account', () => {
    expect(checkRevalleAccount({ recipient, domains: DOMAINS, sessionEmail: 'bia@revalle.com.br' })).toEqual({
      status: 'WRONG_USER',
    });
  });

  it('not required for external e-mails, whatever the session', () => {
    expect(
      checkRevalleAccount({ recipient: signer('ana@gmail.com'), domains: DOMAINS, sessionEmail: 'bia@revalle.com.br' }),
    ).toEqual({ status: 'NOT_REQUIRED' });
  });

  it('isSameEmail never matches empty values', () => {
    expect(isSameEmail('', '')).toBe(false);
    expect(isSameEmail(null, 'a@revalle.com.br')).toBe(false);
  });
});

describe('sanitizeSigningReturnTo', () => {
  it('accepts only /sign/<token>', () => {
    expect(sanitizeSigningReturnTo('/sign/AbC_12-x')).toBe('/sign/AbC_12-x');
    expect(tokenOfSigningReturnTo('/sign/AbC_12-x')).toBe('AbC_12-x');
  });

  it('rejects absolute, protocol-relative, other paths, subpaths, queries and encodings', () => {
    for (const value of [
      'https://evil.example/sign/abc',
      '//evil.example/sign/abc',
      '/\\evil.example',
      '/sign/abc/../../admin',
      '/sign/abc/complete',
      '/sign/abc?next=//evil.example',
      '/sign/abc#x',
      '/sign/',
      '/sign/%2F%2Fevil.example',
      '%2Fsign%2Fabc',
      '/settings',
      '/t/team/documents',
      ' /sign/abc',
      '/sign/abc\n',
      'javascript:alert(1)',
      '',
      null,
      undefined,
      42,
    ]) {
      expect(sanitizeSigningReturnTo(value)).toBeNull();
    }
  });

  it('rejects absurdly long tokens', () => {
    expect(sanitizeSigningReturnTo(`/sign/${'a'.repeat(129)}`)).toBeNull();
  });
});

describe('buildRevalleAccountPath', () => {
  it('sign-in when the account exists, sign-up otherwise, e-mail in lower case', () => {
    expect(buildRevalleAccountPath({ hasAccount: true, email: 'Ana@Revalle.com.br', returnTo: '/sign/abc' })).toBe(
      '/signin?email=ana%40revalle.com.br&returnTo=%2Fsign%2Fabc',
    );
    expect(buildRevalleAccountPath({ hasAccount: false, email: 'ana@revalle.com.br', returnTo: '/sign/abc' })).toBe(
      '/signup?email=ana%40revalle.com.br&returnTo=%2Fsign%2Fabc',
    );
  });
});

describe('parseStoredSigningReturnTo', () => {
  const now = 1_800_000_000_000;

  it('valid and recent', () => {
    expect(parseStoredSigningReturnTo(JSON.stringify({ path: '/sign/abc', savedAt: now - 1000 }), now)).toBe(
      '/sign/abc',
    );
  });

  it('expired after 7 days, from the future, tampered or malformed', () => {
    expect(
      parseStoredSigningReturnTo(JSON.stringify({ path: '/sign/abc', savedAt: now - 8 * 24 * 3600 * 1000 }), now),
    ).toBeNull();
    expect(parseStoredSigningReturnTo(JSON.stringify({ path: '/sign/abc', savedAt: now + 1000 }), now)).toBeNull();
    expect(parseStoredSigningReturnTo(JSON.stringify({ path: '//evil.example', savedAt: now }), now)).toBeNull();
    expect(parseStoredSigningReturnTo('{', now)).toBeNull();
    expect(parseStoredSigningReturnTo('null', now)).toBeNull();
    expect(parseStoredSigningReturnTo(null, now)).toBeNull();
  });
});
