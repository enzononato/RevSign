import { describe, expect, it } from 'vitest';

import { detectInvoice, isValidChaveAcesso } from './detect-invoice';

const checkDigitOf = (first43: string): number => {
  let total = 0;

  for (let position = 0; position < 43; position++) {
    const weight = 2 + ((42 - position) % 8);
    total += Number(first43[position]) * weight;
  }

  const rest = total % 11;

  return rest < 2 ? 0 : 11 - rest;
};

const withCheckDigit = (first43: string) => `${first43}${checkDigitOf(first43)}`;

const VALID_KEY = '29241012345678000195550010000123451123456784';
const WRONG_KEY = `${VALID_KEY.slice(0, 43)}5`;

const spaced = (key: string) => key.match(/.{4}/g)?.join(' ') ?? key;

const filler = 'Texto de apoio do documento para passar do mínimo de caracteres por página. '.repeat(2);

describe('isValidChaveAcesso', () => {
  it('aceita chave com dígito verificador correto', () => {
    expect(VALID_KEY).toHaveLength(44);
    expect(isValidChaveAcesso(VALID_KEY)).toBe(true);
  });

  it('recusa a mesma chave com o último dígito trocado', () => {
    expect(isValidChaveAcesso(WRONG_KEY)).toBe(false);
  });

  it('recusa modelo diferente de 55 e 65 mesmo com dígito verificador certo', () => {
    const modelChanged = `${VALID_KEY.slice(0, 20)}57${VALID_KEY.slice(22)}`;
    const recomputed = withCheckDigit(modelChanged.slice(0, 43));

    expect(isValidChaveAcesso(modelChanged)).toBe(false);
    expect(isValidChaveAcesso(recomputed)).toBe(false);
  });

  it('recusa UF fora da lista do IBGE com dígito verificador certo', () => {
    expect(isValidChaveAcesso(withCheckDigit(`99${VALID_KEY.slice(2, 43)}`))).toBe(false);
  });

  it('recusa mês fora de 01 a 12 com dígito verificador certo', () => {
    expect(isValidChaveAcesso(withCheckDigit(`${VALID_KEY.slice(0, 4)}13${VALID_KEY.slice(6, 43)}`))).toBe(false);
  });

  it('recusa CNPJ do emitente com dígitos verificadores errados', () => {
    expect(isValidChaveAcesso(withCheckDigit(`${VALID_KEY.slice(0, 6)}12345678000196${VALID_KEY.slice(20, 43)}`))).toBe(
      false,
    );
  });

  it('aceita modelo 65', () => {
    expect(isValidChaveAcesso(withCheckDigit(`${VALID_KEY.slice(0, 20)}65${VALID_KEY.slice(22, 43)}`))).toBe(true);
  });

  it('recusa tamanho errado e caracteres que não são dígitos', () => {
    expect(isValidChaveAcesso(VALID_KEY.slice(1))).toBe(false);
    expect(isValidChaveAcesso(`${VALID_KEY.slice(0, 43)}x`)).toBe(false);
  });
});

describe('detectInvoice', () => {
  it('reconhece chave válida escrita em grupos de 4 dígitos', () => {
    const result = detectInvoice([`${filler}\nChave de acesso ${spaced(VALID_KEY)}`]);

    expect(result).toEqual({ status: 'YES', signals: ['CHAVE_ACESSO'] });
  });

  it('reconhece chave válida sem espaços', () => {
    expect(detectInvoice([`${filler} ${VALID_KEY}`]).signals).toContain('CHAVE_ACESSO');
  });

  it('não aceita 44 dígitos com dígito verificador errado', () => {
    expect(detectInvoice([`${filler} ${WRONG_KEY}`])).toEqual({ status: 'NO', signals: [] });
  });

  it('reconhece DANFE', () => {
    expect(detectInvoice([`${filler} DANFE`])).toEqual({ status: 'YES', signals: ['DANFE'] });
  });

  it('reconhece NFS-e', () => {
    expect(detectInvoice([`${filler} NFS-e número 123`])).toEqual({ status: 'YES', signals: ['NFSE'] });
  });

  it('reconhece Nota Fiscal com CNPJ e valor', () => {
    const result = detectInvoice([
      `${filler} Nota Fiscal do fornecedor. CNPJ 00.000.000/0001-91. SÉRIE 1. Natureza da Operação: venda. Total R$ 1.234,56`,
    ]);

    expect(result).toEqual({ status: 'YES', signals: ['NF_CNPJ_VALOR'] });
  });

  it('trata código de barras de boleto de 44 dígitos como NO', () => {
    const boleto = withCheckDigit(`99${VALID_KEY.slice(2, 43)}`);

    expect(detectInvoice([`${filler} ${boleto}`])).toEqual({ status: 'NO', signals: [] });
  });

  it('não marca contrato que só cita nota fiscal, CNPJ e valor', () => {
    const contract = `${filler} Pagamento conforme nota fiscal nº 123, CNPJ 12.345.678/0001-95, R$ 1.000,00.`;

    expect(detectInvoice([contract])).toEqual({ status: 'NO', signals: [] });
  });

  it('exige os termos de apoio na mesma página', () => {
    const first = `${filler} Nota Fiscal CNPJ 12.345.678/0001-95 R$ 10,00`;
    const second = `${filler} Valor Total e Natureza da Operação`;

    expect(detectInvoice([first, second]).status).toBe('NO');
  });

  it('não marca Nota Fiscal sem valor', () => {
    expect(detectInvoice([`${filler} Nota Fiscal do fornecedor. CNPJ 00.000.000/0001-91.`]).status).toBe('NO');
  });

  it('trata um contrato comum como NO', () => {
    const contract = `${filler} CONTRATO DE PRESTAÇÃO DE SERVIÇOS entre as partes, com CNPJ 00.000.000/0001-91 e valor de R$ 500,00.`;

    expect(detectInvoice([contract])).toEqual({ status: 'NO', signals: [] });
  });

  it('acha o sinal em qualquer página', () => {
    expect(detectInvoice([filler, filler, `${filler} DANFE`]).status).toBe('YES');
  });

  it('devolve UNKNOWN para páginas vazias ou quase vazias', () => {
    expect(detectInvoice(['', '  \n '])).toEqual({ status: 'UNKNOWN', signals: [] });
    expect(detectInvoice(['texto curto'])).toEqual({ status: 'UNKNOWN', signals: [] });
  });

  it('com sinal em texto curto devolve YES', () => {
    expect(detectInvoice(['DANFE'])).toEqual({ status: 'YES', signals: ['DANFE'] });
  });

  it('devolve UNKNOWN sem páginas', () => {
    expect(detectInvoice([])).toEqual({ status: 'UNKNOWN', signals: [] });
  });
});
