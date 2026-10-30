import { describe, expect, it } from 'vitest';

import {
  brasiliaToday,
  invoiceDayRange,
  invoiceFiltersToParams,
  parseInvoiceFilterParams,
  readInvoiceFilterParams,
} from './invoice-filters';

describe('filtros da página de notas fiscais', () => {
  it('lê os filtros da URL e volta para a mesma URL', () => {
    const params = new URLSearchParams('de=2026-10-01&ate=2026-10-30&status=COMPLETED&conta=2.1.03&deixadas=1');
    const parsed = parseInvoiceFilterParams(params);

    expect(parsed.success && parsed.data).toEqual({
      from: '2026-10-01',
      to: '2026-10-30',
      status: 'COMPLETED',
      accountCode: '2.1.03',
      deferred: true,
    });
    expect(invoiceFiltersToParams(parsed.success ? parsed.data : {}).toString()).toBe(params.toString());
  });

  it('recusa data, status ou conta inválidos para a planilha e os ignora na tela', () => {
    for (const query of ['de=ontem', 'ate=2026-02-30', 'status=DRAFT', `conta=${'9'.repeat(65)}`]) {
      const params = new URLSearchParams(`${query}&deixadas=1`);

      expect(parseInvoiceFilterParams(params).success, query).toBe(false);
      expect(readInvoiceFilterParams(params), query).toEqual({ deferred: true });
    }
  });

  it('período em dias de Brasília: de 00:00 até o fim do dia final', () => {
    expect(invoiceDayRange({ from: '2026-10-30', to: '2026-10-30' })).toEqual({
      gte: new Date('2026-10-30T03:00:00.000Z'),
      lt: new Date('2026-10-31T03:00:00.000Z'),
    });
    expect(invoiceDayRange({ to: '2026-10-30' })).toEqual({ lt: new Date('2026-10-31T03:00:00.000Z') });
    expect(invoiceDayRange({})).toBeNull();
  });

  it('o dia do nome da planilha é o de Brasília', () => {
    expect(brasiliaToday(new Date('2026-10-31T02:30:00.000Z'))).toBe('2026-10-30');
    expect(brasiliaToday(new Date('2026-10-31T03:00:00.000Z'))).toBe('2026-10-31');
  });
});
