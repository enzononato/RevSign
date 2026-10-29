import { describe, expect, it } from 'vitest';

import { isTemplateDraftEmailExempt } from './recipient-domains';

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
