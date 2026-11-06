import { describe, expect, it } from 'vitest';

import {
  type InvoiceListRowState,
  invoiceAiTitle,
  invoiceRowAction,
  isAwaitingAccounting,
  isAwaitingFinance,
  signerFirstName,
} from './invoice-list-row';

const row = (overrides: Partial<InvoiceListRowState> = {}): InvoiceListRowState => ({
  status: 'PENDING',
  financeStatus: 'PENDING_APPROVAL',
  deleted: false,
  costCenterValidatedAt: null,
  recipients: [
    { name: 'Marina Souza', email: 'marina@revalle.com.br', signingStatus: 'SIGNED' },
    { name: '', email: 'paulo.lima@revalle.com.br', signingStatus: 'NOT_SIGNED' },
  ],
  ...overrides,
});

const both = { isFinance: true, isAccounting: true };
const none = { isFinance: false, isAccounting: false };

describe('invoiceRowAction', () => {
  it('gives Financeiro the approval first when the NF waits both queues', () => {
    expect(invoiceRowAction(row(), both)).toEqual({ kind: 'approve' });
    expect(invoiceRowAction(row(), { isFinance: false, isAccounting: true })).toEqual({ kind: 'validate' });
  });

  it('asks Contabilidade to validate once the account is approved', () => {
    expect(invoiceRowAction(row({ financeStatus: 'APPROVED' }), both)).toEqual({ kind: 'validate' });
  });

  it('never offers an action on a deleted, rejected or superseded NF', () => {
    expect(invoiceRowAction(row({ deleted: true }), both).kind).toBe('waiting');
    expect(
      invoiceRowAction(
        row({
          status: 'REJECTED',
          financeStatus: 'APPROVED',
          recipients: [{ name: 'Ana', email: 'a@x', signingStatus: 'REJECTED' }],
        }),
        both,
      ),
    ).toEqual({ kind: 'rejected' });
    expect(invoiceRowAction(row({ status: 'COMPLETED', financeStatus: 'SUPERSEDED' }), both)).toEqual({
      kind: 'superseded',
    });
  });

  it('shows the first pending signer, by e-mail when there is no name', () => {
    expect(invoiceRowAction(row(), none)).toEqual({ kind: 'waiting', firstName: 'paulo.lima' });
  });

  it('sends the stuck new-version draft again from both queues, even after validation', () => {
    const draft = row({ status: 'DRAFT', financeStatus: 'APPROVED', costCenterValidatedAt: new Date() });

    expect(isAwaitingFinance(draft)).toBe(true);
    expect(isAwaitingAccounting(draft)).toBe(true);
    expect(invoiceRowAction(draft, { isFinance: false, isAccounting: true })).toEqual({ kind: 'resend' });
    expect(invoiceRowAction(draft, none)).toEqual({ kind: 'draft' });
  });

  it('keeps a validated completed NF out of the accounting queue', () => {
    const done = row({ status: 'COMPLETED', financeStatus: 'APPROVED', costCenterValidatedAt: '2026-11-05' });

    expect(isAwaitingAccounting(done)).toBe(false);
    expect(invoiceRowAction(done, both)).toEqual({ kind: 'completed' });
  });
});

describe('invoiceAiTitle', () => {
  it('builds the title from what the AI read, or gives up', () => {
    expect(invoiceAiTitle({ invoiceNumber: '55021', supplierName: 'Distribuidora Vale Gás' })).toBe(
      'NF 55021 · Distribuidora Vale Gás',
    );
    expect(invoiceAiTitle({ invoiceNumber: '7710', supplierName: null })).toBe('NF 7710');
    expect(invoiceAiTitle({ invoiceNumber: '  ', supplierName: null })).toBeNull();
    expect(invoiceAiTitle(null)).toBeNull();
  });
});

describe('signerFirstName', () => {
  it('uses the first word of the name', () => {
    expect(signerFirstName({ name: '  Marina  Souza', email: 'm@x' })).toBe('Marina');
  });
});
