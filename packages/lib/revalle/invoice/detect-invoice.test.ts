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

const FIRST_43 = '3526100000000000019055001000000123100000123';
const VALID_KEY = `${FIRST_43}${checkDigitOf(FIRST_43)}`;
const WRONG_KEY = `${FIRST_43}${(checkDigitOf(FIRST_43) + 1) % 10}`;

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
    const result = detectInvoice([`${filler} Nota Fiscal do fornecedor. CNPJ 00.000.000/0001-91. Total R$ 1.234,56`]);

    expect(result).toEqual({ status: 'YES', signals: ['NF_CNPJ_VALOR'] });
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
    expect(detectInvoice(['DANFE'])).toEqual({ status: 'UNKNOWN', signals: [] });
  });

  it('devolve UNKNOWN sem páginas', () => {
    expect(detectInvoice([])).toEqual({ status: 'UNKNOWN', signals: [] });
  });
});
