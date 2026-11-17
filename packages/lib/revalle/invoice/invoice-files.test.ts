import { describe, expect, it } from 'vitest';

import type { InvoiceMirrorSource } from './invoice-files';
import {
  aggregateIsInvoice,
  aggregateSuggestionStatus,
  fileFinanceStatus,
  formatInvoicePosition,
  invoiceMirrorColumns,
  invoicePositions,
} from './invoice-files';

const K1 = '29241012345678000195550010000123451123456784';
const K2 = '29241098765432000110550010000543211987654321';

const nf = (overrides: Partial<InvoiceMirrorSource> = {}): InvoiceMirrorSource => ({
  suggestionStatus: 'DONE',
  suggestion: { accountCode: '2.1.03', reason: 'Compra de mercadoria.', model: 'gemini-test' },
  suggestionAttempts: 1,
  supplierName: 'Fornecedor A',
  invoiceNumber: '12345',
  totalAmountCents: 15000,
  accessKeys: [],
  choiceCode: null,
  choiceById: null,
  choiceAt: null,
  acceptedSuggestion: null,
  costCenterCode: null,
  costCenterById: null,
  costCenterAt: null,
  costCenterValidatedAt: null,
  costCenterValidatedById: null,
  costCenterValidatedByName: null,
  approvedById: null,
  approvedAt: null,
  approvedAccountName: null,
  approvedByName: null,
  ...overrides,
});

describe('tipo agregado do envio', () => {
  it('uma NF basta; sem NF, o arquivo sem texto deixa em dúvida; sem nada, não é NF', () => {
    expect(aggregateIsInvoice(['OTHER', 'NF'])).toBe('YES');
    expect(aggregateIsInvoice(['OTHER', 'UNKNOWN'])).toBe('UNKNOWN');
    expect(aggregateIsInvoice(['BOLETO', 'OTHER'])).toBe('NO');
    expect(aggregateIsInvoice([])).toBe('NO');
  });
});

describe('situação agregada da IA', () => {
  it('pendente vence, depois falha, depois pronta; sem nada, pulada', () => {
    expect(aggregateSuggestionStatus(['DONE', 'PENDING'])).toBe('PENDING');
    expect(aggregateSuggestionStatus(['DONE', 'DONE'])).toBe('DONE');
    expect(aggregateSuggestionStatus(['DONE', 'FAILED'])).toBe('FAILED');
    expect(aggregateSuggestionStatus(['FAILED', 'PENDING'])).toBe('PENDING');
    expect(aggregateSuggestionStatus(['SKIPPED', 'DONE'])).toBe('DONE');
    expect(aggregateSuggestionStatus(['SKIPPED'])).toBe('SKIPPED');
    expect(aggregateSuggestionStatus([])).toBe('SKIPPED');
  });
});

describe('posição de cada nota no envio', () => {
  it('só as NFs, pela ordem dos arquivos', () => {
    const positions = invoicePositions([
      { id: 'c', kind: 'OTHER', order: 1 },
      { id: 'a', kind: 'NF', order: 2 },
      { id: 'b', kind: 'BOLETO', order: 3 },
      { id: 'd', kind: 'NF', order: 4 },
    ]);

    expect([...positions]).toEqual([
      ['a', { index: 1, total: 2 }],
      ['d', { index: 2, total: 2 }],
    ]);
  });

  it('a entrada fora de ordem sai na ordem dos arquivos; sem NF, vazio', () => {
    const positions = invoicePositions([
      { id: 'z', kind: 'NF', order: 3 },
      { id: 'y', kind: 'NF', order: 1 },
      { id: 'x', kind: 'UNKNOWN', order: 2 },
    ]);

    expect([...positions]).toEqual([
      ['y', { index: 1, total: 2 }],
      ['z', { index: 2, total: 2 }],
    ]);
    expect(invoicePositions([{ id: 'o', kind: 'OTHER', order: 1 }]).size).toBe(0);
  });

  it('texto da posição', () => {
    expect(formatInvoicePosition({ index: 2, total: 3 })).toBe('nota 2 de 3');
    expect(formatInvoicePosition({ index: 1, total: 1 })).toBe('nota 1 de 1');
  });
});

describe('situação de uma nota no Financeiro', () => {
  it('aguardando o Financeiro com a nota aprovada = aprovada; o resto vem do envio', () => {
    expect(fileFinanceStatus('PENDING_APPROVAL', new Date())).toBe('APPROVED');
    expect(fileFinanceStatus('PENDING_APPROVAL', '2026-11-16T10:00:00.000Z')).toBe('APPROVED');
    expect(fileFinanceStatus('PENDING_APPROVAL', null)).toBe('PENDING_APPROVAL');
    expect(fileFinanceStatus('APPROVED', null)).toBe('APPROVED'); // reserva solta da nova versão
    expect(fileFinanceStatus('SUPERSEDED', new Date())).toBe('SUPERSEDED');
    expect(fileFinanceStatus('LEGACY', null)).toBe('LEGACY');
    expect(fileFinanceStatus(null, null)).toBeNull();
  });
});

describe('espelho na linha do envio', () => {
  it('uma nota: as colunas dela, iguais', () => {
    const only = nf({
      choiceCode: '2.1.03',
      choiceById: 7,
      choiceAt: new Date('2026-11-16T09:00:00.000Z'),
      acceptedSuggestion: true,
      costCenterCode: '101',
      costCenterById: 7,
      costCenterAt: new Date('2026-11-16T09:01:00.000Z'),
      costCenterValidatedAt: new Date('2026-11-16T12:00:00.000Z'),
      costCenterValidatedById: 9,
      costCenterValidatedByName: 'Contabilidade',
      approvedById: 8,
      approvedAt: new Date('2026-11-16T10:00:00.000Z'),
      approvedAccountName: 'Fornecedores',
      approvedByName: 'Financeiro',
      accessKeys: [K1],
    });

    expect(invoiceMirrorColumns([only])).toEqual(only);
  });

  it('duas notas: o que é de uma nota fica nulo, as chaves se somam e a aprovação é a última quando todas têm', () => {
    const a = nf({
      choiceCode: '2.1.03',
      choiceById: 7,
      costCenterCode: '101',
      costCenterValidatedAt: new Date('2026-11-16T12:00:00.000Z'),
      accessKeys: [K1],
      approvedById: 8,
      approvedAt: new Date('2026-11-16T10:00:00.000Z'),
      approvedAccountName: 'Fornecedores',
      approvedByName: 'Financeiro',
    });
    const b = nf({ suggestionStatus: 'PENDING', suggestion: null, accessKeys: [K2, K1], approvedAt: null });

    const mirror = invoiceMirrorColumns([a, b]);

    expect(mirror.choiceCode).toBeNull();
    expect(mirror.choiceById).toBeNull();
    expect(mirror.costCenterCode).toBeNull();
    expect(mirror.costCenterValidatedAt).toBeNull();
    expect(mirror.supplierName).toBeNull();
    expect(mirror.invoiceNumber).toBeNull();
    expect(mirror.totalAmountCents).toBeNull();
    expect(mirror.suggestion).toBeNull();
    expect(mirror.accessKeys).toEqual([K1, K2]);
    expect(mirror.suggestionStatus).toBe('PENDING');
    expect(mirror.suggestionAttempts).toBe(2);
    expect(mirror.approvedAt).toBeNull();
    expect(mirror.approvedById).toBeNull();

    const later = new Date('2026-11-16T11:00:00.000Z');
    const approved = invoiceMirrorColumns([a, { ...b, approvedAt: later, approvedById: 9, approvedByName: 'Outro' }]);

    expect(approved.approvedAt).toEqual(later);
    expect(approved.approvedById).toBeNull();
    expect(approved.approvedAccountName).toBeNull();
    expect(approved.approvedByName).toBeNull();

    // A ordem não muda a escolha da última aprovação.
    expect(invoiceMirrorColumns([{ ...b, approvedAt: later }, a]).approvedAt).toEqual(later);
  });

  it('nenhuma nota: tudo vazio, chaves vazias e IA pulada', () => {
    const mirror = invoiceMirrorColumns([]);

    expect(mirror.accessKeys).toEqual([]);
    expect(mirror.suggestionStatus).toBe('SKIPPED');
    expect(mirror.suggestionAttempts).toBe(0);
    expect(mirror.choiceCode).toBeNull();
    expect(mirror.approvedAt).toBeNull();
    expect(mirror.suggestion).toBeNull();
  });

  it('não devolve o mesmo array da nota (gravar o espelho não muda a linha lida)', () => {
    const only = nf({ accessKeys: [K1] });

    expect(invoiceMirrorColumns([only]).accessKeys).not.toBe(only.accessKeys);
  });
});
