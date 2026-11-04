import { describe, expect, it } from 'vitest';

import type { InvoiceReadyInput } from './invoice-ready';
import { isInvoiceReady } from './invoice-ready';

const account = { code: '2.1.03' };
const costCenter = { code: '101' };

const ready = (overrides: Partial<InvoiceReadyInput> = {}): InvoiceReadyInput => ({
  isClassified: true,
  isError: false,
  isHeld: false,
  hasNoAccounts: false,
  state: { isInvoice: 'YES', choice: account, costCenter },
  ...overrides,
});

describe('o bloco da nota fiscal libera o envio', () => {
  it('NF com a conta e o centro libera; faltando um dos dois, não', () => {
    expect(isInvoiceReady(ready())).toBe(true);
    expect(isInvoiceReady(ready({ state: { isInvoice: 'YES', choice: account, costCenter: null } }))).toBe(false);
    expect(isInvoiceReady(ready({ state: { isInvoice: 'YES', choice: null, costCenter } }))).toBe(false);
    expect(isInvoiceReady(ready({ state: { isInvoice: 'YES', choice: null, costCenter: null } }))).toBe(false);
  });

  it('lista de contas vazia bloqueia, mesmo com conta e centro já escolhidos', () => {
    expect(isInvoiceReady(ready({ hasNoAccounts: true }))).toBe(false);
  });

  it('nova versão com o envio parado libera só com a conta: o centro é exigido no primeiro envio', () => {
    const withoutCenter = { isInvoice: 'YES', choice: account, costCenter: null } as const;

    expect(isInvoiceReady(ready({ state: withoutCenter, requiresCostCenter: false }))).toBe(true);
    expect(isInvoiceReady(ready({ state: withoutCenter }))).toBe(false);
    expect(
      isInvoiceReady(ready({ state: { isInvoice: 'YES', choice: null, costCenter }, requiresCostCenter: false })),
    ).toBe(false);
  });

  it('nova versão de uma NF que ainda não tem conta libera sem ela, só quando a correção do centro pede', () => {
    const withoutAccount = { isInvoice: 'YES', choice: null, costCenter } as const;

    expect(isInvoiceReady(ready({ state: withoutAccount, requiresChoice: false, requiresCostCenter: false }))).toBe(
      true,
    );
    expect(isInvoiceReady(ready({ state: withoutAccount, requiresCostCenter: false }))).toBe(false);
  });

  it('documento comum libera sem nada; escaneado só depois da resposta; nova versão com o Financeiro bloqueia', () => {
    expect(isInvoiceReady(ready({ state: { isInvoice: 'NO', choice: null, costCenter: null } }))).toBe(true);
    expect(isInvoiceReady(ready({ state: { isInvoice: 'UNKNOWN', choice: null, costCenter: null } }))).toBe(false);
    expect(isInvoiceReady(ready({ isHeld: true }))).toBe(false);
  });

  it('antes da classificação não libera; erro na consulta libera (o servidor confere no envio)', () => {
    expect(isInvoiceReady(ready({ isClassified: false }))).toBe(false);
    expect(isInvoiceReady(ready({ state: undefined }))).toBe(false);
    expect(isInvoiceReady(ready({ state: undefined, isError: true }))).toBe(true);
  });
});
