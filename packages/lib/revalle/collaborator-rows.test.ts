import { describe, expect, it } from 'vitest';

import {
  estimateSendHours,
  isInactiveSituacao,
  parseCollaboratorTable,
  parseCollaboratorText,
} from './collaborator-rows';

describe('parseCollaboratorText', () => {
  it('lê colagem separada por tab com cabeçalho', () => {
    const rows = parseCollaboratorText(
      'Nome\tE-mail\tCPF\nAna\tana@x.com\t123.456.789-09\nBia\tbia@x.com\t98765432100',
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ line: 2, name: 'Ana', email: 'ana@x.com', cpf: '12345678909' });
  });

  it('sem cabeçalho assume nome, e-mail, cpf', () => {
    expect(parseCollaboratorText('Ana;ana@x.com;12345678909')).toEqual([
      { line: 1, name: 'Ana', email: 'ana@x.com', cpf: '12345678909' },
    ]);
  });

  it('respeita a ordem do cabeçalho', () => {
    expect(parseCollaboratorText('CPF;Nome;Email\n12345678909;Ana;ana@x.com')[0]).toMatchObject({
      name: 'Ana',
      email: 'ana@x.com',
      cpf: '12345678909',
    });
  });

  it('ignora linhas vazias e aceita vírgula', () => {
    const rows = parseCollaboratorText('\nAna,ana@x.com,12345678909\n\n  \nBia,bia@x.com,98765432100\n');

    expect(rows.map((row) => row.line)).toEqual([2, 5]);
  });

  it('lança ROW_LIMIT acima de 3000 linhas', () => {
    const text = Array.from({ length: 3001 }, (_, i) => `N${i};n${i}@x.com;12345678909`).join('\n');

    expect(() => parseCollaboratorText(text)).toThrow('ROW_LIMIT');
  });
});

describe('parseCollaboratorTable', () => {
  it('detecta cabeçalho com acento e caixa', () => {
    expect(
      parseCollaboratorTable([
        ['E-MAIL', 'Nôme', 'cpf'],
        ['a@x.com', 'Ana', '123.456.789-09'],
      ]),
    ).toEqual([{ line: 2, name: 'Ana', email: 'a@x.com', cpf: '12345678909' }]);
  });
});

describe('estimateSendHours', () => {
  it('arredonda para cima', () => {
    expect(estimateSendHours(1180, 100)).toBe(12);
  });
});

describe('isInactiveSituacao', () => {
  it.each(['Inativo', 'DESLIGADO', 'Demitido', 'Rescisão', 'Falecido'])('%s é inativo', (value) => {
    expect(isInactiveSituacao(value)).toBe(true);
  });

  it.each([null, '', 'Ativo', 'Afastado', 'Férias'])('%s é ativo', (value) => {
    expect(isInactiveSituacao(value)).toBe(false);
  });
});

describe('parser robusto', () => {
  const ok = 'a@x.com';

  it('reconhece sinônimos de cabeçalho', () => {
    const rows = parseCollaboratorText('Nome completo;E-mail corporativo;CPF do colaborador\nAna;a@x.com;12345678909');

    expect(rows[0]).toMatchObject({ name: 'Ana', email: ok, cpf: '12345678909' });
  });

  it('aceita Email e E-mail', () => {
    expect(parseCollaboratorText('Email\tNome\tCPF\na@x.com\tAna\t12345678909')[0].name).toBe('Ana');
    expect(parseCollaboratorText('E-mail\tNome\tCPF\na@x.com\tAna\t12345678909')[0].email).toBe(ok);
  });

  it('só uma coluna reconhecida não é cabeçalho', () => {
    expect(parseCollaboratorText('Nome;a@x.com;12345678909')).toHaveLength(1);
  });

  it('campo entre aspas com quebra de linha continua uma linha', () => {
    const rows = parseCollaboratorText('Nome;Email;CPF\n"Ana\nSilva";a@x.com;12345678909\nBia;b@x.com;98765432100');

    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe('Ana\nSilva');
    expect(rows[1].line).toBe(4);
  });

  it('campo entre aspas com vírgula e ponto e vírgula', () => {
    expect(parseCollaboratorText('"Silva, Ana";a@x.com;12345678909')[0].name).toBe('Silva, Ana');
    expect(parseCollaboratorText('"Silva; Ana",a@x.com,12345678909')[0].name).toBe('Silva; Ana');
  });

  it('CRLF, BOM e colunas vazias no fim', () => {
    const rows = parseCollaboratorText('\uFEFFNome\tEmail\tCPF\t\t\r\nAna\ta@x.com\t12345678909\t\t\r\n');

    expect(rows).toEqual([{ line: 2, name: 'Ana', email: ok, cpf: '12345678909' }]);
  });

  it('completa com zeros CPF de 9 e 10 dígitos', () => {
    expect(parseCollaboratorText('Ana;a@x.com;1234567890')[0].cpf).toBe('01234567890');
    expect(parseCollaboratorText('Ana;a@x.com;123456789')[0].cpf).toBe('00123456789');
  });

  it('limite: 3000 passa, 3001 lança; cabeçalho e linhas vazias não contam', () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => `N${i};n${i}@x.com;12345678909`);

    expect(parseCollaboratorText(['Nome;Email;CPF', '', ...make(3000)].join('\n'))).toHaveLength(3000);
    expect(() => parseCollaboratorText(['Nome;Email;CPF', ...make(3001)].join('\n'))).toThrow('ROW_LIMIT');
  });
});

describe('isInactiveSituacao valores exatos', () => {
  it.each(['false', 'F', 'n', 'Não', '0'])('%s é inativo', (value) => {
    expect(isInactiveSituacao(value)).toBe(true);
  });

  it.each(['true', 'S', '1'])('%s é ativo', (value) => {
    expect(isInactiveSituacao(value)).toBe(false);
  });
});
