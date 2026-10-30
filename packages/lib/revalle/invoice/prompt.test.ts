import { describe, expect, it } from 'vitest';

import { buildInvoicePrompt } from './prompt';

const accounts = [
  { code: '2.1.03', name: 'Fornecedores', description: 'Compras a prazo', kind: 'PAYABLE' },
  { code: '1.1.02', name: 'Clientes', description: '', kind: null },
];

describe('buildInvoicePrompt', () => {
  it('traz o prompt do usuário antes do bloco fixo', () => {
    const result = buildInvoicePrompt({ userPrompt: 'Você é analista contábil.', accounts });

    expect(result.startsWith('Você é analista contábil.')).toBe(true);
    expect(result.indexOf('Você é analista contábil.')).toBeLessThan(result.indexOf('2.1.03'));
  });

  it('lista cada conta como código — nome', () => {
    const result = buildInvoicePrompt({ userPrompt: 'x', accounts });

    expect(result).toContain('2.1.03 — Fornecedores');
    expect(result).toContain('1.1.02 — Clientes');
    expect(result).toContain('Compras a prazo');
  });

  it('manda responder só com JSON', () => {
    const result = buildInvoicePrompt({ userPrompt: 'x', accounts });

    expect(result).toContain('Responda só com JSON');
    expect(result).toContain('accountCode');
  });

  it('gera o bloco fixo mesmo com prompt vazio', () => {
    const result = buildInvoicePrompt({ userPrompt: '   ', accounts });

    expect(result.startsWith('Contas contábeis disponíveis:')).toBe(true);
    expect(result).toContain('2.1.03 — Fornecedores');
    expect(result).toContain('Responda só com JSON');
  });
});
