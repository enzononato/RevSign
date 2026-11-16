import { describe, expect, it } from 'vitest';

import {
  findExternalEmail,
  formatInvoiceExternalRecipientMessage,
  isExternalEmail,
  isTemplateDraftEmailExempt,
  isTemplatePlaceholderEmail,
} from './recipient-domains';

const DOMAINS = ['revalle.com.br', 'revallenordeste.com.br', 'revallepe.com.br'];

describe('isTemplateDraftEmailExempt', () => {
  it('accepts the template placeholder, the direct link recipient and empty e-mails', () => {
    expect(isTemplateDraftEmailExempt('recipient.1@documenso.com')).toBe(true);
    expect(isTemplateDraftEmailExempt('Recipient.12@Documenso.com')).toBe(true);
    expect(isTemplateDraftEmailExempt('direct.link@documenso.com')).toBe(true);
    expect(isTemplateDraftEmailExempt('')).toBe(true);
    expect(isTemplateDraftEmailExempt(null)).toBe(true);
  });

  it('rejects look-alikes of the placeholder (anchored)', () => {
    expect(isTemplateDraftEmailExempt('x.recipient.1@documenso.com.evil.example')).toBe(false);
    expect(isTemplateDraftEmailExempt('xrecipient.1@documenso.com')).toBe(false);
    expect(isTemplateDraftEmailExempt('recipient.1@documenso.com.br')).toBe(false);
    expect(isTemplateDraftEmailExempt('fulano@gmail.com')).toBe(false);
  });
});

describe('isTemplatePlaceholderEmail', () => {
  it('is true only for the exact placeholders, never for empty e-mails', () => {
    expect(isTemplatePlaceholderEmail(' Recipient.3@documenso.com ')).toBe(true);
    expect(isTemplatePlaceholderEmail('direct.link@documenso.com')).toBe(true);
    expect(isTemplatePlaceholderEmail('')).toBe(false);
    expect(isTemplatePlaceholderEmail(undefined)).toBe(false);
    expect(isTemplatePlaceholderEmail('x.recipient.1@documenso.com.evil.example')).toBe(false);
  });
});

describe('isExternalEmail', () => {
  it('flags e-mails outside the company domains', () => {
    expect(isExternalEmail('fulano@gmail.com', DOMAINS)).toBe(true);
    expect(isExternalEmail('fulano@revalle.com.br.evil.example', DOMAINS)).toBe(true);
    expect(isExternalEmail('fulano@sub.revalle.com.br', DOMAINS)).toBe(true);
  });

  it('accepts company e-mails in any case and with spaces around', () => {
    expect(isExternalEmail(' Fulano@Revalle.com.br ', DOMAINS)).toBe(false);
    expect(isExternalEmail('ciclano@revallepe.com.br', DOMAINS)).toBe(false);
  });

  it('never flags empty e-mails, nor anything without a domain list', () => {
    expect(isExternalEmail('', DOMAINS)).toBe(false);
    expect(isExternalEmail(null, DOMAINS)).toBe(false);
    expect(isExternalEmail('fulano@gmail.com', [])).toBe(false);
  });
});

describe('findExternalEmail', () => {
  it('returns the first external e-mail, trimmed', () => {
    expect(findExternalEmail(['a@revalle.com.br', ' B@Gmail.com ', 'c@outlook.com'], DOMAINS)).toBe('B@Gmail.com');
  });

  it('returns null when every e-mail is from the company (or empty)', () => {
    expect(findExternalEmail(['a@revalle.com.br', '', null, 'b@revallenordeste.com.br'], DOMAINS)).toBeNull();
  });
});

describe('formatInvoiceExternalRecipientMessage', () => {
  it('names the domains and the e-mail', () => {
    expect(formatInvoiceExternalRecipientMessage('x@gmail.com', DOMAINS)).toBe(
      'Nota fiscal só pode ser enviada para e-mails da empresa (@revalle.com.br, @revallenordeste.com.br ou @revallepe.com.br). Troque o e-mail de x@gmail.com.',
    );
  });
});
