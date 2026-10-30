import { describe, expect, it } from 'vitest';

import { decodeCsvBytes, parseAccountsCsv } from './accounts-csv';

const HEADER = 'numero;nome;descricao;tipo';

describe('parseAccountsCsv', () => {
  it('lê contas com acento, BOM e fim de linha do Windows', () => {
    const text = `﻿${HEADER}\r\n2.1.03;Fornecedores;Compras a prazo;pagar\r\n1.1.02;Clientes;Vendas a prazo;receber\r\n3.2.01;Manutenção;Peças e serviços;\r\n`;

    const result = parseAccountsCsv(text);

    expect(result.errors).toEqual([]);
    expect(result.accounts).toEqual([
      { code: '2.1.03', name: 'Fornecedores', description: 'Compras a prazo', kind: 'PAYABLE' },
      { code: '1.1.02', name: 'Clientes', description: 'Vendas a prazo', kind: 'RECEIVABLE' },
      { code: '3.2.01', name: 'Manutenção', description: 'Peças e serviços', kind: null },
    ]);
  });

  it('aponta a linha sem nome e segue com as outras', () => {
    const result = parseAccountsCsv(`${HEADER}\n1.1;Caixa;;\n2.1;;sem nome;pagar\n3.1;Banco;;\n`);

    expect(result.errors).toEqual([{ line: 3, message: 'Falta o nome da conta' }]);
    expect(result.accounts.map((account) => account.code)).toEqual(['1.1', '3.1']);
  });

  it('aponta a linha sem número', () => {
    expect(parseAccountsCsv(`${HEADER}\n;Caixa;;\n`).errors).toEqual([{ line: 2, message: 'Falta o número da conta' }]);
  });

  it('entende pagar, receber e vazio em qualquer caixa', () => {
    const result = parseAccountsCsv(`${HEADER}\n1;A;;PAGAR\n2;B;; Receber \n3;C;;\n`);

    expect(result.accounts.map((account) => account.kind)).toEqual(['PAYABLE', 'RECEIVABLE', null]);
  });

  it('recusa tipo desconhecido', () => {
    const result = parseAccountsCsv(`${HEADER}\n1;A;;x\n`);

    expect(result.accounts).toEqual([]);
    expect(result.errors).toEqual([{ line: 2, message: 'Tipo inválido: use pagar, receber ou deixe em branco' }]);
  });

  it('marca como erro a segunda ocorrência de um número repetido', () => {
    const result = parseAccountsCsv(`${HEADER}\n1.1;Caixa;;\n1.1;Outro;;\n`);

    expect(result.accounts).toHaveLength(1);
    expect(result.errors).toEqual([{ line: 3, message: 'Número de conta repetido: 1.1' }]);
  });

  it('exige o cabeçalho', () => {
    const result = parseAccountsCsv('1.1;Caixa;;\n');

    expect(result.accounts).toEqual([]);
    expect(result.errors[0]?.line).toBe(1);
  });

  it('avisa quando o arquivo está vazio', () => {
    expect(parseAccountsCsv('').errors).toEqual([{ line: 1, message: 'O arquivo está vazio' }]);
  });

  it('aceita campo entre aspas com ponto e vírgula', () => {
    const result = parseAccountsCsv(`${HEADER}\n1.1;"Água; luz";"Contas ""fixas""";pagar\n`);

    expect(result.accounts[0]).toMatchObject({ name: 'Água; luz', description: 'Contas "fixas"' });
  });

  it('aceita descrição entre aspas com várias linhas e conta a linha seguinte certo', () => {
    const result = parseAccountsCsv(`${HEADER}\n1.1;Caixa;"linha um\nlinha dois";\n2.1;;x;\n`);

    expect(result.accounts[0]?.description).toBe('linha um\nlinha dois');
    expect(result.errors).toEqual([{ line: 4, message: 'Falta o nome da conta' }]);
  });

  it('dá erro na linha onde começa uma aspa sem fechar', () => {
    const result = parseAccountsCsv(`${HEADER}\n1.1;Caixa;;\n2.1;Banco;"sem fim;\n3.1;Outro;;\n`);

    expect(result.errors).toEqual([{ line: 3, message: 'Aspas sem fechar' }]);
  });

  it('pede UTF-8 quando o texto tem caractere de substituição', () => {
    const result = parseAccountsCsv(`${HEADER}\n1.1;Manuten\uFFFD\uFFFDo;;\n`);

    expect(result.accounts).toEqual([]);
    expect(result.errors).toEqual([
      { line: 1, message: 'Salve o arquivo como CSV UTF-8 (no Excel: Salvar como → CSV UTF-8).' },
    ]);
  });
});

describe('decodeCsvBytes', () => {
  it('lê UTF-8', () => {
    const bytes = new TextEncoder().encode('numero;nome;descrição;tipo');

    expect(decodeCsvBytes(bytes)).toEqual({ text: 'numero;nome;descrição;tipo', encoding: 'utf-8' });
  });

  it('cai para windows-1252 com cabeçalho em Latin-1', () => {
    const bytes = Uint8Array.from(
      [...'numero;nome;descri'].map((char) => char.charCodeAt(0)).concat([0xe7, 0xe3, 0x6f]),
    );

    expect(decodeCsvBytes(bytes)).toEqual({ text: 'numero;nome;descrição', encoding: 'windows-1252' });
  });
});
