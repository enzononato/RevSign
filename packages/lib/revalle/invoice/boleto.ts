import { z } from 'zod';

import { normalizeInvoiceData } from './invoice-data';

/**
 * Fase 9: o boleto que vem junto com as notas fiscais. O valor e o vencimento saem primeiro da linha digitável (aqui, sem
 * IA, com os dígitos conferidos); a IA completa o beneficiário e o CNPJ. Tudo é texto tirado de um documento qualquer:
 * `normalizeBoletoData` nunca lança e deixa vazio o que não faz sentido.
 */
export type BoletoData = {
  beneficiaryName: string | null;
  beneficiaryCnpj: string | null;
  amountCents: number | null;
  /** AAAA-MM-DD. */
  dueDate: string | null;
  /** 47 dígitos, só números. */
  digitableLine: string | null;
};

export const EMPTY_BOLETO_DATA: BoletoData = {
  beneficiaryName: null,
  beneficiaryCnpj: null,
  amountCents: null,
  dueDate: null,
  digitableLine: null,
};

const DIGITABLE_LINE_LENGTH = 47;
const DAY_MS = 86_400_000;

// O fator de vencimento conta dias a partir de 07/10/1997; chegou a 9999 em 21/02/2025 e recomeçou em 1000 no dia
// seguinte. Um fator vale nas duas bases: fica o vencimento mais perto da data de referência.
const FACTOR_BASE = Date.UTC(1997, 9, 7);
const FACTOR_RESTART_BASE = Date.UTC(2025, 1, 22);

const digitsOf = (text: string) => text.replace(/\D/g, '');

/** DV módulo 10 de um campo da linha: pesos 2 e 1 a partir da direita, somando os dígitos de cada produto. */
const mod10 = (digits: string) => {
  let sum = 0;
  let weight = 2;

  for (let index = digits.length - 1; index >= 0; index--) {
    const product = Number(digits[index]) * weight;

    sum += Math.floor(product / 10) + (product % 10);
    weight = weight === 2 ? 1 : 2;
  }

  return (10 - (sum % 10)) % 10;
};

/** DV geral do código de barras (sem a posição 5): pesos 2 a 9 a partir da direita; 0, 10 e 11 viram 1. */
const mod11 = (digits: string) => {
  let sum = 0;
  let weight = 2;

  for (let index = digits.length - 1; index >= 0; index--) {
    sum += Number(digits[index]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }

  const dv = 11 - (sum % 11);

  return dv === 0 || dv === 10 || dv === 11 ? 1 : dv;
};

/** Os 47 dígitos da linha, se os três DVs dos campos e o DV geral conferem; senão `null`. */
const checkedLine = (text: string): string | null => {
  const line = digitsOf(text);

  if (line.length !== DIGITABLE_LINE_LENGTH) {
    return null;
  }

  const fields: Array<[string, string]> = [
    [line.slice(0, 9), line[9]],
    [line.slice(10, 20), line[20]],
    [line.slice(21, 31), line[31]],
  ];

  if (fields.some(([field, dv]) => mod10(field) !== Number(dv))) {
    return null;
  }

  const barcodeWithoutDv = `${line.slice(0, 4)}${line.slice(33, 47)}${line.slice(4, 9)}${line.slice(10, 20)}${line.slice(21, 31)}`;

  return mod11(barcodeWithoutDv) === Number(line[32]) ? line : null;
};

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const dueDateOf = (factor: number, reference: Date): string | null => {
  if (factor === 0) {
    return null;
  }

  const candidates = [FACTOR_BASE + factor * DAY_MS];

  if (factor >= 1000) {
    candidates.push(FACTOR_RESTART_BASE + (factor - 1000) * DAY_MS);
  }

  const target = reference.getTime();
  const nearest = candidates.reduce((best, candidate) =>
    Math.abs(candidate - target) < Math.abs(best - target) ? candidate : best,
  );

  return isoDay(nearest);
};

/**
 * Banco, valor e vencimento da linha digitável de um boleto bancário (47 dígitos, com ou sem pontuação). `null` se não
 * tem 47 dígitos ou um dígito verificador não confere. Fator `0000` = sem vencimento; valor zero = sem valor.
 */
export const parseDigitableLine = (
  text: string,
  reference: Date,
): { bankCode: string; amountCents: number | null; dueDate: string | null } | null => {
  const line = checkedLine(text);

  if (!line) {
    return null;
  }

  const amountCents = Number(line.slice(37, 47));

  return {
    bankCode: line.slice(0, 3),
    amountCents: amountCents > 0 ? amountCents : null,
    dueDate: dueDateOf(Number(line.slice(33, 37)), reference),
  };
};

// A linha como os bancos imprimem ("34191.09123 34567.812341 56789.012301 1 16470000150000") ou os 47 dígitos juntos.
const LINE_PATTERN =
  /(?<!\d)\d{5}[.\s]?\d{5}\s*\d{5}[.\s]?\d{6}\s*\d{5}[.\s]?\d{6}\s*\d\s*\d{14}(?!\d)|(?<!\d)\d{47}(?!\d)/g;

// Só boleto imprime estas. As fracas (beneficiário, vencimento, local de pagamento) aparecem em contrato e fatura, e
// um contrato tomado por boleto teria o texto mandado para a IA.
const STRONG_BOLETO_MARKERS = [
  /linha\s+digitavel/,
  /ficha\s+de\s+compensacao/,
  /recibo\s+do\s+(?:pagador|sacado)/,
  /nosso\s+numero/,
];

const WEAK_BOLETO_MARKERS = [/beneficiario|cedente/, /local\s+de\s+pagamento/, /vencimento/];

const MIN_BOLETO_MARKERS = 3;

const normalizeText = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Boleto pelo texto: uma linha digitável de 47 dígitos válida, ou pelo menos três marcas de boleto com uma forte entre
 * elas (sem acento, minúsculo). Devolve a primeira linha válida, só com os dígitos.
 */
export const detectBoleto = (pages: string[]): { isBoleto: boolean; digitableLine: string | null } => {
  const text = pages.join('\n');
  const digitableLine =
    (text.match(LINE_PATTERN) ?? []).map(checkedLine).find((line): line is string => line !== null) ?? null;

  if (digitableLine) {
    return { isBoleto: true, digitableLine };
  }

  const normalized = normalizeText(text);
  const strong = STRONG_BOLETO_MARKERS.filter((marker) => marker.test(normalized)).length;
  const weak = WEAK_BOLETO_MARKERS.filter((marker) => marker.test(normalized)).length;

  return { isBoleto: strong >= 1 && strong + weak >= MIN_BOLETO_MARKERS, digitableLine: null };
};

/**
 * Formato pedido ao Gemini para o boleto: simples como o da NF (texto e número, `nullable().optional()`, com `trim()` e
 * `finite()` para o SDK mandar `{ type, nullable: true }`). `dueDate` é a chave que diz ao servidor falso dos testes que o
 * pedido é de boleto.
 */
export const ZBoletoResponseSchema = z.object({
  beneficiaryName: z.string().trim().nullable().optional(),
  beneficiaryCnpj: z.string().trim().nullable().optional(),
  amount: z.number().finite().nullable().optional(),
  dueDate: z.string().trim().nullable().optional(),
  digitableLine: z.string().trim().nullable().optional(),
});

const isValidCnpj = (digits: string): boolean => {
  if (!/^\d{14}$/.test(digits) || /^(\d)\1{13}$/.test(digits)) {
    return false;
  }

  const checkDigit = (length: number) => {
    let sum = 0;
    let weight = length - 7;

    for (let index = 0; index < length; index++) {
      sum += Number(digits[index]) * weight;
      weight = weight === 2 ? 9 : weight - 1;
    }

    const rest = sum % 11;

    return rest < 2 ? 0 : 11 - rest;
  };

  return checkDigit(12) === Number(digits[12]) && checkDigit(13) === Number(digits[13]);
};

const readCnpj = (value: unknown) => {
  if (typeof value !== 'string') {
    return null;
  }

  const digits = digitsOf(value);

  return isValidCnpj(digits) ? digits : null;
};

const readIsoDate = (value: unknown) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return null;
  }

  const day = value.trim();
  const parsed = Date.parse(`${day}T00:00:00Z`);

  return Number.isFinite(parsed) && isoDay(parsed) === day ? day : null;
};

// O nome e o valor passam pela mesma limpeza dos dados da NF: espaços, caracteres invisíveis, CPF mascarado, palavra no
// lugar do dado, corte de tamanho; valor só como número em reais, dentro do que a coluna inteira guarda.
const readName = (value: unknown) => normalizeInvoiceData({ supplierName: value }).supplierName;

const readAmountCents = (value: unknown) => normalizeInvoiceData({ totalAmount: value }).totalAmountCents;

const readDigitableLine = (value: unknown) => (typeof value === 'string' ? checkedLine(value) : null);

/** Os cinco campos da resposta da IA (`amount` em reais). Nunca lança; CNPJ só se válido; data só AAAA-MM-DD real. */
export const normalizeBoletoData = (raw: unknown): BoletoData => {
  try {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ...EMPTY_BOLETO_DATA };
    }

    const fields: Record<string, unknown> = { ...raw };

    return {
      beneficiaryName: readName(fields.beneficiaryName),
      beneficiaryCnpj: readCnpj(fields.beneficiaryCnpj),
      amountCents: readAmountCents(fields.amount),
      dueDate: readIsoDate(fields.dueDate),
      digitableLine: readDigitableLine(fields.digitableLine),
    };
  } catch {
    return { ...EMPTY_BOLETO_DATA };
  }
};

/** O `BoletoData` gravado na linha do arquivo (`boletoData`), conferido campo a campo. `null` quando não há. */
export const readStoredBoletoData = (raw: unknown): BoletoData | null => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const fields: Record<string, unknown> = { ...raw };
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  const cents = fields.amountCents;

  return {
    beneficiaryName: text(fields.beneficiaryName),
    beneficiaryCnpj: text(fields.beneficiaryCnpj),
    amountCents: typeof cents === 'number' && Number.isSafeInteger(cents) && cents > 0 ? cents : null,
    dueDate: readIsoDate(fields.dueDate),
    digitableLine: text(fields.digitableLine),
  };
};

/** Junta o que a linha digitável deu com o que a IA leu. A linha vence; o que ela não tem vem da IA. */
export const mergeBoletoData = (
  fromLine: Pick<BoletoData, 'amountCents' | 'dueDate' | 'digitableLine'> | null,
  fromAi: BoletoData | null,
): BoletoData => ({
  beneficiaryName: fromAi?.beneficiaryName ?? null,
  beneficiaryCnpj: fromAi?.beneficiaryCnpj ?? null,
  amountCents: fromLine?.amountCents ?? fromAi?.amountCents ?? null,
  dueDate: fromLine?.dueDate ?? fromAi?.dueDate ?? null,
  digitableLine: fromLine?.digitableLine ?? fromAi?.digitableLine ?? null,
});

/** O que a linha digitável de um texto dá (`null` sem linha válida): o ponto de partida do `boletoData`. */
export const boletoLineData = (
  digitableLine: string | null,
  reference: Date,
): Pick<BoletoData, 'amountCents' | 'dueDate' | 'digitableLine'> | null => {
  const parsed = digitableLine ? parseDigitableLine(digitableLine, reference) : null;

  return parsed && digitableLine
    ? { amountCents: parsed.amountCents, dueDate: parsed.dueDate, digitableLine: digitsOf(digitableLine) }
    : null;
};

/** Instruções fixas da leitura do boleto (sem a lista de contas e sem o prompt do admin, que é sobre a conta da NF). */
export const BOLETO_PROMPT = [
  'Leia o boleto enviado e copie dele os dados abaixo.',
  'Responda só com JSON, sem texto antes ou depois, neste formato:',
  '{"beneficiaryName": "<nome ou razão social do beneficiário (cedente)>", "beneficiaryCnpj": "<CNPJ do beneficiário, 14 dígitos, só números>", "amount": <valor do documento em reais, número com ponto decimal>, "dueDate": "<data de vencimento, AAAA-MM-DD>", "digitableLine": "<linha digitável, 47 dígitos, só números>"}',
  'Se um dado não estiver claro, responda null, sem aspas, em vez de adivinhar. O beneficiário é quem recebe o pagamento, não o pagador.',
].join('\n');
