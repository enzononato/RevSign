import { describe, expect, it } from 'vitest';

import { FINANCE_FILTER_LABELS, financeStatusLabel } from './finance-status';

describe('financeStatusLabel', () => {
  it('mostra a situação de cada estado', () => {
    expect(financeStatusLabel('AWAITING_ACCOUNT', 'DRAFT')).toBe('Aguardando a conta');
    expect(financeStatusLabel('PENDING_APPROVAL', 'PENDING')).toBe('Aguardando aprovação');
    expect(financeStatusLabel('PENDING_APPROVAL', 'COMPLETED')).toBe('Aguardando aprovação');
    expect(financeStatusLabel('APPROVED', 'COMPLETED')).toBe('Aprovada');
    expect(financeStatusLabel('SUPERSEDED', 'PENDING')).toBe('Substituída');
    expect(financeStatusLabel('LEGACY', 'COMPLETED')).toBe('Antiga, sem aprovação');
  });

  it('rascunho aprovado ainda não saiu; recusada não aguarda mais; sem estado, vazio', () => {
    expect(financeStatusLabel('APPROVED', 'DRAFT')).toBe('Aprovada, ainda não enviada');
    expect(financeStatusLabel('PENDING_APPROVAL', 'REJECTED')).toBe('Sem aprovação (recusada)');
    expect(financeStatusLabel(null, 'COMPLETED')).toBe('');
  });

  it('o filtro padrão do Financeiro se chama "Aguardando o Financeiro"', () => {
    expect(FINANCE_FILTER_LABELS.pendentes).toBe('Aguardando o Financeiro');
  });
});
