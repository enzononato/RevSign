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

// Fase 8: a chave da duplicada vale para os quatro modelos de documento fiscal eletrônico: NF-e (55), CT-e (57), NFC-e
// (65) e CT-e OS (67). A DETECÇÃO de nota fiscal continua só com 55 e 65 (`isValidChaveAcesso`): reconhecer um CT-e
// sozinho como nota fiscal está fora do escopo. Sem `models`, vale a estrutura de qualquer modelo (`extractAccessKeys`).
const hasValidChaveStructure = (digits44: string, models?: readonly string[]): boolean => {
  if (!/^\d{44}$/.test(digits44)) {
    return false;
  }

  const month = Number(digits44.slice(4, 6));
  const model = digits44.slice(20, 22);

  if (!UF_CODES.has(Number(digits44.slice(0, 2))) || month < 1 || month > 12) {
    return false;
  }

  if ((models && !models.includes(model)) || !isValidCnpj(digits44.slice(6, 20))) {
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

export const isValidChaveAcesso = (digits44: string): boolean => hasValidChaveStructure(digits44, ['55', '65']);

/** Chave de NF-e, CT-e, NFC-e ou CT-e OS (modelos 55, 57, 65 e 67): UF, mês, CNPJ e dígito verificador certos. */
export const isValidChaveDocumento = (digits44: string): boolean =>
  hasValidChaveStructure(digits44, ['55', '57', '65', '67']);

/**
 * A chave PRÓPRIA da nota em cada página: a primeira chave estruturalmente válida do texto, de qualquer modelo (com ou sem
 * espaços), que só conta se for do modelo 55, 57, 65 ou 67. Um DANFE ou um DACTE imprime a chave dele no cabeçalho e a
 * repete em cada página; as que aparecem depois são de notas citadas (a devolução traz a da nota original, o CT-e traz a
 * das NF-e transportadas) e, se entrassem, fariam a nota citada acusar a que a cita. Parar em qualquer modelo impede que um
 * DAMDFE (58), que imprime a própria chave, adote a que cita. Página com o sinal de NFS-e e sem o de DANFE não dá chave: a
 * NFS-e não tem chave de 44 dígitos, e a que aparece nela é de uma nota citada.
 * Limite: um layout que imprime uma chave citada antes da própria pode tanto perder o casamento por chave quanto acusar por
 * engano, e uma página de continuação sem chave própria pode trazer a citada.
 */
export const extractAccessKeys = (pages: string[]): string[] => {
  const keys = new Set<string>();

  // Página por página: um grupo de 4 dígitos não atravessa a quebra de página.
  for (const page of pages) {
    if (NFSE_PATTERN.test(page) && !DANFE_PATTERN.test(page)) {
      continue;
    }

    const first = (page.match(CHAVE_PATTERN) ?? [])
      .map((candidate) => candidate.replace(/\s/g, ''))
      .find((digits) => hasValidChaveStructure(digits));

    if (first !== undefined && isValidChaveDocumento(first)) {
      keys.add(first);
    }
  }

  return [...keys];
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
