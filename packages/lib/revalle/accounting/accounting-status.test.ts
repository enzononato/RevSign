import { describe, expect, it } from 'vitest';

import {
  ACCOUNTING_FILTER_LABELS,
  ACCOUNTING_FILTERS,
  accountingStatusLabel,
  invoicesDefaultFilters,
} from './accounting-status';

describe('accountingStatusLabel', () => {
  it('NF sem centro de custo não aguarda validação: falta o centro', () => {
    expect(accountingStatusLabel({ costCenterCode: null, costCenterValidatedAt: null })).toBe('Sem centro de custo');
  });

  it('com centro e sem validação aguarda a Contabilidade', () => {
    expect(accountingStatusLabel({ costCenterCode: '101', costCenterValidatedAt: null })).toBe('Aguardando validação');
  });

  it('com centro e validação está validada, com a data como Date ou como texto (vinda do tRPC)', () => {
    const validated = { costCenterCode: '201' };

    expect(accountingStatusLabel({ ...validated, costCenterValidatedAt: new Date('2026-11-04T12:00:00Z') })).toBe(
      'Validado',
    );
    expect(accountingStatusLabel({ ...validated, costCenterValidatedAt: '2026-11-04T12:00:00.000Z' })).toBe('Validado');
  });
});

describe('filtro da Contabilidade', () => {
  it('tem os três valores, com o texto da tela', () => {
    expect(ACCOUNTING_FILTERS).toEqual(['pendentes', 'validadas', 'todas']);
    expect(ACCOUNTING_FILTER_LABELS).toEqual({
      pendentes: 'Aguardando a Contabilidade',
      validadas: 'Validadas',
      todas: 'Todas',
    });
  });
});

describe('invoicesDefaultFilters', () => {
  it('Financeiro abre na fila do Financeiro', () => {
    expect(invoicesDefaultFilters({ isFinance: true, isAccounting: false })).toEqual({ financeiro: 'pendentes' });
  });

  it('só a Contabilidade abre na fila da Contabilidade', () => {
    expect(invoicesDefaultFilters({ isFinance: false, isAccounting: true })).toEqual({ contabilidade: 'pendentes' });
  });

  it('quem tem os dois perfis abre só na fila do Financeiro (nunca as duas juntas)', () => {
    expect(invoicesDefaultFilters({ isFinance: true, isAccounting: true })).toEqual({ financeiro: 'pendentes' });
  });

  it('quem não tem perfil abre sem filtro', () => {
    expect(invoicesDefaultFilters({ isFinance: false, isAccounting: false })).toEqual({});
  });
});
