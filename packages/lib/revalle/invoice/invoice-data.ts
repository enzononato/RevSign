import { isValidChaveAcesso } from './detect-invoice';

/**
 * Fase 8: o que a IA leu da nota fiscal junto com a sugestão de conta. É texto tirado de um documento qualquer, então
 * nada daqui é confiável: tudo passa por `normalizeInvoiceData`, que nunca lança e deixa vazio o que não faz sentido.
 */
export type InvoiceData = {
  supplierName: string | null;
  invoiceNumber: string | null;
  totalAmountCents: number | null;
  accessKey: string | null;
};

export const EMPTY_INVOICE_DATA: InvoiceData = {
  supplierName: null,
  invoiceNumber: null,
  totalAmountCents: null,
  accessKey: null,
};

/** As colunas da linha da NF que espelham os dados lidos pela IA, todas vazias. Vão junto de toda gravação que apaga a sugestão. */
export const NO_INVOICE_DATA_COLUMNS = { supplierName: null, invoiceNumber: null, totalAmountCents: null };

export const INVOICE_SUPPLIER_MAX_LENGTH = 200;
export const INVOICE_NUMBER_MAX_LENGTH = 60;

/** Maior valor que a coluna `totalAmountCents` (INTEGER do Postgres) guarda: R$ 21.474.836,47. */
export const INVOICE_AMOUNT_MAX_CENTS = 2_147_483_647;

// Caracteres de espaço e de quebra de linha viram um espaço; os demais de controle, os de formatação (entre eles os que
// invertem o sentido do texto, U+202E) e o par solto de um caractere de dois códigos saem. Quem lê o fornecedor na tela
// ou na planilha vê o que está escrito, e o JSON da coluna `suggestion` nunca recebe um par solto.
const SPACING = /[\p{White_Space}]+/gu;
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}]/gu;

const cleanText = (value: string, maxLength: number): string | null => {
  const cleaned = Array.from(value.replace(SPACING, ' ').replace(INVISIBLE, '').replace(/ {2,}/g, ' ').trim())
    .slice(0, maxLength)
    .join('')
    .trim();

  return cleaned || null;
};

const readSupplierName = (value: unknown) =>
  typeof value === 'string' ? cleanText(value, INVOICE_SUPPLIER_MAX_LENGTH) : null;

// O número da nota é número na maioria dos documentos: a IA pode devolver 123 em vez de "123".
const readInvoiceNumber = (value: unknown) => {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }

  return typeof value === 'string' ? cleanText(value, INVOICE_NUMBER_MAX_LENGTH) : null;
};

// Só número: "R$ 1.234,56" como texto fica vazio, porque 1.234 pode ser mil duzentos e trinta e quatro ou um e meio.
const readAmountCents = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  const cents = Math.round(value * 100);

  return cents >= 1 && cents <= INVOICE_AMOUNT_MAX_CENTS ? cents : null;
};

const readAccessKey = (value: unknown) => {
  if (typeof value !== 'string') {
    return null;
  }

  const digits = value.replace(/\s/g, '');

  return isValidChaveAcesso(digits) ? digits : null;
};

/** Os quatro campos da resposta da IA (`supplierName`, `invoiceNumber`, `totalAmount` em reais, `accessKey`). */
export const normalizeInvoiceData = (raw: unknown): InvoiceData => {
  try {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ...EMPTY_INVOICE_DATA };
    }

    const fields: Record<string, unknown> = { ...raw };

    return {
      supplierName: readSupplierName(fields.supplierName),
      invoiceNumber: readInvoiceNumber(fields.invoiceNumber),
      totalAmountCents: readAmountCents(fields.totalAmount),
      accessKey: readAccessKey(fields.accessKey),
    };
  } catch {
    return { ...EMPTY_INVOICE_DATA };
  }
};

const groupThousands = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

const splitCents = (cents: number) => ({
  reais: String(Math.floor(cents / 100)),
  centavos: String(cents % 100).padStart(2, '0'),
});

/** `R$ 1.234,56`. */
export const formatInvoiceAmount = (cents: number): string => {
  const { reais, centavos } = splitCents(cents);

  return `R$ ${groupThousands(reais)},${centavos}`;
};

/** `1234,56`: a planilha leva só os dígitos e a vírgula, sem símbolo nem ponto de milhar. */
export const formatInvoiceAmountCsv = (cents: number): string => {
  const { reais, centavos } = splitCents(cents);

  return `${reais},${centavos}`;
};

export type InvoiceDataSummary = Pick<InvoiceData, 'supplierName' | 'invoiceNumber' | 'totalAmountCents'>;

/** `Fornecedor · Nº 12345 · R$ 1.234,56`, só com o que existe; `null` quando não há nada. */
export const formatInvoiceDataLine = (data: InvoiceDataSummary | null | undefined): string | null => {
  if (!data) {
    return null;
  }

  const parts = [
    data.supplierName,
    data.invoiceNumber ? `Nº ${data.invoiceNumber}` : null,
    data.totalAmountCents === null ? null : formatInvoiceAmount(data.totalAmountCents),
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(' · ') : null;
};

/** Os três dados que ficam na linha da NF, ou `null` quando os três estão vazios. */
export const toInvoiceDataSummary = (data: InvoiceDataSummary): InvoiceDataSummary | null =>
  data.supplierName === null && data.invoiceNumber === null && data.totalAmountCents === null
    ? null
    : { supplierName: data.supplierName, invoiceNumber: data.invoiceNumber, totalAmountCents: data.totalAmountCents };
