export type InvoiceSignal = 'CHAVE_ACESSO' | 'DANFE' | 'NFSE' | 'NF_CNPJ_VALOR';

export type InvoiceDetection = {
  status: 'YES' | 'NO' | 'UNKNOWN';
  signals: InvoiceSignal[];
};

const MIN_CHARS_PER_PAGE = 50;

const CHAVE_PATTERN = /(?<!\d)(?:\d{4}\s){10}\d{4}(?!\d)|(?<!\d)\d{44}(?!\d)/g;
const DANFE_PATTERN = /\bDANFE\b|Documento\s+Auxiliar\s+da\s+Nota\s+Fiscal/i;
const NFSE_PATTERN = /\bNFS-?e\b|Nota\s+Fiscal\s+(?:Eletr[ôo]nica\s+)?de\s+Servi[cç]os?/i;
const NOTA_FISCAL_PATTERN = /Nota\s+Fiscal/i;
const CNPJ_PATTERN = /CNPJ/i;
const VALOR_PATTERN = /R\$|Valor\s+Total/i;

export const isValidChaveAcesso = (digits44: string): boolean => {
  if (!/^\d{44}$/.test(digits44)) {
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

export const detectInvoice = (pages: string[]): InvoiceDetection => {
  const text = pages.join('\n');
  const charCount = pages.reduce((total, page) => total + page.replace(/\s/g, '').length, 0);

  if (pages.length === 0 || charCount / pages.length < MIN_CHARS_PER_PAGE) {
    return { status: 'UNKNOWN', signals: [] };
  }

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

  if (NOTA_FISCAL_PATTERN.test(text) && CNPJ_PATTERN.test(text) && VALOR_PATTERN.test(text)) {
    signals.push('NF_CNPJ_VALOR');
  }

  return { status: signals.length > 0 ? 'YES' : 'NO', signals };
};
