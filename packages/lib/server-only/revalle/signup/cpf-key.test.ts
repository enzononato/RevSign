import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { hashCpfForRateLimit } from './cpf-key';

const KEY = 'chave-de-teste-nao-usar-em-producao';

describe('hashCpfForRateLimit', () => {
  it('gives 64 hex characters that do not contain the CPF', () => {
    const hash = hashCpfForRateLimit('11144477735', KEY);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('11144477735');
  });

  it('is the same for the same CPF with or without mask', () => {
    expect(hashCpfForRateLimit('111.444.777-35', KEY)).toBe(hashCpfForRateLimit('11144477735', KEY));
  });

  it('changes with the CPF and with the key', () => {
    const base = hashCpfForRateLimit('11144477735', KEY);

    expect(hashCpfForRateLimit('52998224725', KEY)).not.toBe(base);
    expect(hashCpfForRateLimit('11144477735', `${KEY}-outra`)).not.toBe(base);
  });

  it('is a keyed hash: it is not the plain SHA-256 of the CPF', () => {
    const plain = createHash('sha256').update('11144477735').digest('hex');

    expect(hashCpfForRateLimit('11144477735', KEY)).not.toBe(plain);
  });
});
