import { describe, expect, it } from 'vitest';

import { validateSuggestion } from './suggestion';

const active = new Set(['2.1.03', '1.1.02']);

describe('validateSuggestion', () => {
  it('aceita sugestão de conta ativa', () => {
    const raw = { accountCode: '2.1.03', confidence: 'alta', reason: 'Compra de fornecedor' };

    expect(validateSuggestion(raw, active)).toEqual(raw);
  });

  it('aceita o JSON como texto', () => {
    const raw = JSON.stringify({ accountCode: '1.1.02', confidence: 'media', reason: 'Venda' });

    expect(validateSuggestion(raw, active)?.accountCode).toBe('1.1.02');
  });

  it('recusa conta que não existe na lista ativa', () => {
    expect(validateSuggestion({ accountCode: '9.9.99', confidence: 'alta', reason: 'x' }, active)).toBeNull();
  });

  it('corta o motivo em 200 caracteres', () => {
    const result = validateSuggestion({ accountCode: '2.1.03', confidence: 'baixa', reason: 'a'.repeat(300) }, active);

    expect(result?.reason).toHaveLength(200);
  });

  it('recusa JSON inválido e formatos errados', () => {
    expect(validateSuggestion('{não é json', active)).toBeNull();
    expect(validateSuggestion(null, active)).toBeNull();
    expect(validateSuggestion({ accountCode: '2.1.03', confidence: 'certeza', reason: 'x' }, active)).toBeNull();
    expect(validateSuggestion({ accountCode: '2.1.03', confidence: 'alta' }, active)).toBeNull();
  });
});
