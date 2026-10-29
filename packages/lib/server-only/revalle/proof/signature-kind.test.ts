import { describe, expect, it } from 'vitest';

import { classifySignature } from './signature-kind';

describe('classifySignature', () => {
  it('imagem vence texto', () => {
    expect(
      classifySignature([{ typedSignature: 'Maria' }, { signatureImageAsBase64: 'data:image/png;base64,AAA' }]),
    ).toBe('IMAGE');
  });

  it('só texto digitado é TYPED', () => {
    expect(classifySignature([{ signatureImageAsBase64: null, typedSignature: 'Maria' }])).toBe('TYPED');
  });

  it('vazio, nulo ou em branco é NONE', () => {
    expect(classifySignature([])).toBe('NONE');
    expect(classifySignature([null, { typedSignature: '  ' }])).toBe('NONE');
  });
});
