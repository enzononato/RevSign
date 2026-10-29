import { describe, expect, it } from 'vitest';

import { hasRevalleEmailChanged } from './email-change';

describe('hasRevalleEmailChanged', () => {
  it('ignores case and surrounding spaces', () => {
    expect(hasRevalleEmailChanged('Fulano@Revalle.com.br', ' fulano@revalle.com.br ')).toBe(false);
  });

  it('detects a different address', () => {
    expect(hasRevalleEmailChanged('fulano@revalle.com.br', 'beltrano@revalle.com.br')).toBe(true);
  });

  it('treats an omitted e-mail as unchanged', () => {
    expect(hasRevalleEmailChanged('fulano@revalle.com.br', undefined)).toBe(false);
  });
});
