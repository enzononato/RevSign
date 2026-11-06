import { describe, expect, it } from 'vitest';

import {
  buildColaboradorSourceSql,
  missingRequiredFields,
  parseColumnOverrides,
  pickColaboradorColumns,
  quoteIdentifier,
} from './colaboradores-source';

const col = (name: string, type = 'text') => ({ name, type });

describe('pickColaboradorColumns', () => {
  it('acha as colunas da view do contrato', () => {
    const mapping = pickColaboradorColumns([col('cpf'), col('nome'), col('data_nascimento', 'date'), col('situacao')]);

    expect(mapping.cpf?.name).toBe('cpf');
    expect(mapping.data_nascimento?.name).toBe('data_nascimento');
    expect(missingRequiredFields(mapping)).toEqual([]);
  });

  it('acha nomes de outra base, inclusive com maiúsculas e acentos', () => {
    const mapping = pickColaboradorColumns([
      col('CPF'),
      col('Nome_Completo'),
      col('Dt_Nascimento', 'timestamp without time zone'),
      col('Situação'),
      col('status'),
    ]);

    expect(mapping.nome?.name).toBe('Nome_Completo');
    expect(mapping.data_nascimento?.name).toBe('Dt_Nascimento');
    expect(mapping.situacao?.name).toBe('Situação');
  });

  it('acusa o que falta sem inventar coluna', () => {
    const mapping = pickColaboradorColumns([col('cpf'), col('nome'), col('cargo')]);

    expect(missingRequiredFields(mapping)).toEqual(['data_nascimento']);
    expect(mapping.email).toBeUndefined();
  });

  it('a configuração vence a detecção e ignora coluna que não existe', () => {
    const columns = [col('cpf'), col('nome'), col('apelido'), col('nasc_texto')];
    const mapping = pickColaboradorColumns(columns, {
      nome: 'apelido',
      data_nascimento: 'nasc_texto',
      email: 'nao_existe',
    });

    expect(mapping.nome?.name).toBe('apelido');
    expect(mapping.data_nascimento?.name).toBe('nasc_texto');
    expect(mapping.email).toBeUndefined();
  });
});

describe('parseColumnOverrides', () => {
  it('lê pares e descarta campo desconhecido', () => {
    expect(parseColumnOverrides(' nome = nome_completo , data_nascimento=dt_nasc, foo=bar,,')).toEqual({
      nome: 'nome_completo',
      data_nascimento: 'dt_nasc',
    });
    expect(parseColumnOverrides(undefined)).toEqual({});
  });
});

describe('buildColaboradorSourceSql', () => {
  it('aspas em tudo que vem do catálogo, inclusive hífen e aspas', () => {
    expect(quoteIdentifier('colaboradores-revalle')).toBe('"colaboradores-revalle"');
    expect(quoteIdentifier('a"b')).toBe('"a""b"');

    const sql = buildColaboradorSourceSql('public', 'colaboradores-revalle', {
      cpf: col('CPF'),
      nome: col('nome'),
      data_nascimento: col('nasc', 'date'),
    });

    expect(sql).toContain('FROM "public"."colaboradores-revalle" t');
    expect(sql).toContain(`regexp_replace(t."CPF"::text, '\\D', '', 'g') AS cpf`);
    expect(sql).toContain(`to_char(t."nasc", 'YYYY-MM-DD') AS data_nascimento`);
    expect(sql).toContain('NULL::text AS email');
  });

  it('data em texto converte dd/mm/aaaa e aaaa-mm-dd', () => {
    const sql = buildColaboradorSourceSql('public', 't', {
      cpf: col('cpf'),
      nome: col('nome'),
      data_nascimento: col('nasc'),
    });

    expect(sql).toContain(`'^\\d{2}/\\d{2}/\\d{4}'`);
    expect(sql).toContain(`'^\\d{4}-\\d{2}-\\d{2}'`);
  });
});
