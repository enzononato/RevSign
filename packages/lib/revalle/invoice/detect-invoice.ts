export type InvoiceSignal = 'CHAVE_ACESSO' | 'DANFE' | 'NFSE' | 'NF_CNPJ_VALOR';

export type InvoiceDetection = {
  status: 'YES' | 'NO' | 'UNKNOWN';
  signals: InvoiceSignal[];
};

const MIN_CHARS_PER_PAGE = 50;

const CHAVE_PATTERN = /(?<!\d)(?:\d{4}\s){10}\d{4}(?!\d)|(?<!\d)\d{44}(?!\d)/g;
const DANFE_PATTERN = /\bDANFE\b|Documento\s+Auxiliar\s+da\s+Nota\s+Fiscal/i;
const NFSE_PATTERN = /\bNFS-?e\b|Nota\s+Fiscal\s+(?:Eletr[ôo]nica\s+)?de\s+Servi[cç]os?/i;

const UF_CODES = new Set([
  11, 12, 13, 14, 15, 16, 17, 21, 22, 23, 24, 25, 26, 27, 28, 29, 31, 32, 33, 35, 41, 42, 43, 50, 51, 52, 53,
]);

const NF_SUPPORT_TERMS = [
  /valor\s+total/,
  /natureza\s+da\s+operacao/,
  /\bserie\b/,
  /chave\s+de\s+acesso/,
  /discriminacao\s+dos\s+servicos/,
  /inscricao\s+municipal/,
  /\biss\b/,
  /\bicms\b/,
];

const normalizeText = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const isValidCnpj = (digits14: string): boolean => {
  if (!/^\d{14}$/.test(digits14) || /^(\d)\1{13}$/.test(digits14)) {
    return false;
  }

  const checkDigit = (length: number) => {
    let sum = 0;
    let weight = length - 7;

    for (let index = 0; index < length; index++) {
      sum += Number(digits14[index]) * weight;
      weight = weight === 2 ? 9 : weight - 1;
    }

    const rest = sum % 11;

    return rest < 2 ? 0 : 11 - rest;
  };

  return checkDigit(12) === Number(digits14[12]) && checkDigit(13) === Number(digits14[13]);
};

export const isValidChaveAcesso = (digits44: string): boolean => {
  if (!/^\d{44}$/.test(digits44)) {
    return false;
  }

  const month = Number(digits44.slice(4, 6));
  const model = digits44.slice(20, 22);

  if (!UF_CODES.has(Number(digits44.slice(0, 2))) || month < 1 || month > 12) {
    return false;
  }

  if ((model !== '55' && model !== '65') || !isValidCnpj(digits44.slice(6, 20))) {
    return false;
  }

  let sum = 0;
  let weight = 2;

  for (let index = 42; index >= 0; index--) {
    sum += Number(digits44[index]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }

  const remainder = sum % 11;
  const checkDigit = remainder < 2 ? 0 : 11 - remainder;

  return checkDigit === Number(digits44[43]);
};

const pageLooksLikeInvoice = (page: string): boolean => {
  if (!/nota\s+fiscal/i.test(page) || !/CNPJ/i.test(page) || !page.includes('R$')) {
    return false;
  }

  const normalized = normalizeText(page);

  return NF_SUPPORT_TERMS.filter((term) => term.test(normalized)).length >= 2;
};

export const detectInvoice = (pages: string[]): InvoiceDetection => {
  const text = pages.join('\n');
  const charCount = pages.reduce((total, page) => total + page.replace(/\s/g, '').length, 0);

  const signals: InvoiceSignal[] = [];

  const hasChave = (text.match(CHAVE_PATTERN) ?? []).some((candidate) =>
    isValidChaveAcesso(candidate.replace(/\s/g, '')),
  );

  if (hasChave) {
    signals.push('CHAVE_ACESSO');
  }

  if (DANFE_PATTERN.test(text)) {
    signals.push('DANFE');
  }

  if (NFSE_PATTERN.test(text)) {
    signals.push('NFSE');
  }

  if (pages.some(pageLooksLikeInvoice)) {
    signals.push('NF_CNPJ_VALOR');
  }

  if (signals.length > 0) {
    return { status: 'YES', signals };
  }

  const isSparse = pages.length === 0 || charCount / pages.length < MIN_CHARS_PER_PAGE;

  return { status: isSparse ? 'UNKNOWN' : 'NO', signals };
};
