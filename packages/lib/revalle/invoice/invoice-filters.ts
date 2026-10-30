import { DateTime } from 'luxon';
import { z } from 'zod';

import { REVALLE_TIME_ZONE } from '../date-format';

export const INVOICE_EXPORT_LIMIT = 10_000;

export const INVOICE_EXPORT_LIMIT_MESSAGE = 'Filtre por período para exportar menos de 10.000 notas.';

export const INVOICE_DATE_ORDER_MESSAGE = 'A data inicial é depois da data final.';

/** Status mostrado (tela e planilha) para a NF que o remetente excluiu; só o admin a vê. */
export const INVOICE_DELETED_LABEL = 'excluído pelo remetente';

export const isOverInvoiceExportLimit = (count: number) => count > INVOICE_EXPORT_LIMIT;

/** Notas fiscais da página são as já enviadas: rascunho não entra. */
export const INVOICE_LIST_STATUSES = ['PENDING', 'COMPLETED', 'REJECTED', 'CANCELLED'] as const;

export type InvoiceListStatus = (typeof INVOICE_LIST_STATUSES)[number];

export const INVOICE_STATUS_LABELS: Record<InvoiceListStatus, string> = {
  PENDING: 'Pendente',
  COMPLETED: 'Concluído',
  REJECTED: 'Recusado',
  CANCELLED: 'Cancelado',
};

const ZDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => DateTime.fromISO(value, { zone: REVALLE_TIME_ZONE }).isValid);

export const ZInvoiceFiltersSchema = z.object({
  from: ZDaySchema.optional(),
  to: ZDaySchema.optional(),
  status: z.enum(INVOICE_LIST_STATUSES).optional(),
  accountCode: z.string().trim().min(1).max(64).optional(),
  deferred: z.boolean().optional(),
});

export type TInvoiceFilters = z.infer<typeof ZInvoiceFiltersSchema>;

/** Nomes dos filtros na URL da página e da planilha (a planilha usa os mesmos da tela). */
export const INVOICE_FILTER_PARAMS = {
  from: 'de',
  to: 'ate',
  status: 'status',
  accountCode: 'conta',
  deferred: 'deixadas',
} as const;

const readParams = (params: URLSearchParams) => {
  const value = (name: string) => {
    const raw = params.get(name)?.trim();

    return raw ? raw : undefined;
  };

  return {
    from: value(INVOICE_FILTER_PARAMS.from),
    to: value(INVOICE_FILTER_PARAMS.to),
    status: value(INVOICE_FILTER_PARAMS.status),
    accountCode: value(INVOICE_FILTER_PARAMS.accountCode),
    deferred: params.get(INVOICE_FILTER_PARAMS.deferred) === '1' ? true : undefined,
  };
};

/** Filtros da URL. Um valor inválido torna o resultado inválido (a planilha responde 400). */
export const parseInvoiceFilterParams = (params: URLSearchParams) =>
  ZInvoiceFiltersSchema.safeParse(readParams(params));

/** Erro de combinação dos filtros (cada um válido sozinho), ou `null`. Datas `AAAA-MM-DD` comparam como texto. */
export const invoiceFiltersError = ({ from, to }: Pick<TInvoiceFilters, 'from' | 'to'>) =>
  from && to && from > to ? INVOICE_DATE_ORDER_MESSAGE : null;

/** Mesma leitura, mas para a tela: o filtro inválido é ignorado em vez de quebrar a página. */
export const readInvoiceFilterParams = (params: URLSearchParams): TInvoiceFilters => {
  const raw = readParams(params);
  const filters: TInvoiceFilters = {};

  for (const key of Object.keys(raw) as (keyof TInvoiceFilters)[]) {
    const parsed = ZInvoiceFiltersSchema.shape[key].safeParse(raw[key]);

    if (parsed.success && parsed.data !== undefined) {
      Object.assign(filters, { [key]: parsed.data });
    }
  }

  return filters;
};

export const invoiceFiltersToParams = (filters: TInvoiceFilters) => {
  const params = new URLSearchParams();

  if (filters.from) {
    params.set(INVOICE_FILTER_PARAMS.from, filters.from);
  }

  if (filters.to) {
    params.set(INVOICE_FILTER_PARAMS.to, filters.to);
  }

  if (filters.status) {
    params.set(INVOICE_FILTER_PARAMS.status, filters.status);
  }

  if (filters.accountCode) {
    params.set(INVOICE_FILTER_PARAMS.accountCode, filters.accountCode);
  }

  if (filters.deferred) {
    params.set(INVOICE_FILTER_PARAMS.deferred, '1');
  }

  return params;
};

/**
 * Período em dias do calendário de Brasília: `from` desde 00:00 e `to` até o fim do dia (limite exclusivo no início do
 * dia seguinte). Sem nenhum dos dois, `null`.
 */
export const invoiceDayRange = ({ from, to }: Pick<TInvoiceFilters, 'from' | 'to'>) => {
  if (!from && !to) {
    return null;
  }

  const startOf = (day: string) => DateTime.fromISO(day, { zone: REVALLE_TIME_ZONE }).startOf('day');

  return {
    ...(from ? { gte: startOf(from).toJSDate() } : {}),
    ...(to ? { lt: startOf(to).plus({ days: 1 }).toJSDate() } : {}),
  };
};

/** "AAAA-MM-DD" de hoje em Brasília, para o nome da planilha. */
export const brasiliaToday = (now: Date = new Date()) =>
  DateTime.fromJSDate(now).setZone(REVALLE_TIME_ZONE).toFormat('yyyy-MM-dd');
