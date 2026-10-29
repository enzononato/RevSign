// REVALLE: padrão do motivo trocado para o do RevSign.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NEXT_PRIVATE_SIGNING_REASON } from './app';

describe('NEXT_PRIVATE_SIGNING_REASON', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to the RevSign signing reason', () => {
    vi.stubEnv('NEXT_PRIVATE_SIGNING_REASON', undefined);

    expect(NEXT_PRIVATE_SIGNING_REASON()).toBe('Selado pelo RevSign (Revalle)');
  });

  it('uses the default for an empty signing reason', () => {
    vi.stubEnv('NEXT_PRIVATE_SIGNING_REASON', '');

    expect(NEXT_PRIVATE_SIGNING_REASON()).toBe('Selado pelo RevSign (Revalle)');
  });

  it('uses the configured signing reason verbatim', () => {
    vi.stubEnv('NEXT_PRIVATE_SIGNING_REASON', 'Signed by Objective');

    expect(NEXT_PRIVATE_SIGNING_REASON()).toBe('Signed by Objective');
  });
});
