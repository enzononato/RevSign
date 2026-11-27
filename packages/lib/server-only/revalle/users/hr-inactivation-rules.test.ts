import { describe, expect, it } from 'vitest';

import type { Colaborador } from '../colaboradores/map-row';
import { exceedsHrSweepCap, findDismissedCpfs, HR_SWEEP_CHUNK_SIZE, hrSweepCap } from './hr-inactivation-rules';

const row = (cpf: string, situacao: string | null): Colaborador => ({
  cpf,
  nome: 'Pessoa Fictícia',
  dataNascimento: '1990-01-01',
  cargo: null,
  setor: null,
  unidade: null,
  matricula: null,
  email: null,
  telefone: null,
  situacao,
});

const fakeRepository = (rows: Colaborador[], { failOnCall }: { failOnCall?: number } = {}) => {
  const calls: string[][] = [];

  return {
    calls,
    findManyByCpf: (cpfs: string[]): Promise<Colaborador[]> => {
      calls.push(cpfs);

      if (failOnCall === calls.length) {
        return Promise.reject(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }));
      }

      return Promise.resolve(rows.filter((item) => cpfs.includes(item.cpf)));
    },
  };
};

describe('hrSweepCap', () => {
  it('é o maior entre 10 e 5% das contas vinculadas ativas (para cima)', () => {
    expect(hrSweepCap(0)).toBe(10);
    expect(hrSweepCap(100)).toBe(10);
    expect(hrSweepCap(200)).toBe(10);
    expect(hrSweepCap(201)).toBe(11);
    expect(hrSweepCap(1000)).toBe(50);
  });

  it('a env troca o teto por um número fixo; vazia ou inválida fica no padrão', () => {
    expect(hrSweepCap(1000, '3')).toBe(3);
    expect(hrSweepCap(10, ' 0 ')).toBe(0);
    expect(hrSweepCap(1000, '')).toBe(50);
    expect(hrSweepCap(1000, 'abc')).toBe(50);
    expect(hrSweepCap(1000, '-5')).toBe(50);
    expect(hrSweepCap(1000, undefined)).toBe(50);
  });
});

describe('exceedsHrSweepCap', () => {
  it('trava só acima do teto', () => {
    expect(exceedsHrSweepCap(10, 20)).toBe(false);
    expect(exceedsHrSweepCap(11, 20)).toBe(true);
    expect(exceedsHrSweepCap(50, 1000)).toBe(false);
    expect(exceedsHrSweepCap(51, 1000)).toBe(true);
    expect(exceedsHrSweepCap(4, 1000, '3')).toBe(true);
  });

  it('uma base pequena com tudo desligado (mapeamento errado) trava', () => {
    expect(exceedsHrSweepCap(12, 12)).toBe(true);
  });
});

describe('findDismissedCpfs', () => {
  it('só desligado em todas as linhas conta; readmitido, ausente e afastado não', async () => {
    const repository = fakeRepository([
      row('11111111111', 'desligado'),
      row('22222222222', 'demitido'),
      row('22222222222', 'ativo'), // readmissão
      row('33333333333', 'afastado'),
      row('44444444444', null),
      row('55555555555', 'Rescisão'),
      row('55555555555', 'falecido'),
    ]);

    const dismissed = await findDismissedCpfs(repository, [
      '11111111111',
      '22222222222',
      '33333333333',
      '44444444444',
      '55555555555',
      '99999999999', // ausente do RH
    ]);

    expect([...dismissed].sort()).toEqual(['11111111111', '55555555555']);
  });

  it('consulta em blocos e lança se um bloco falha (quem chama não grava nada)', async () => {
    const cpfs = Array.from({ length: HR_SWEEP_CHUNK_SIZE + 1 }, (_, index) => String(index).padStart(11, '0'));
    const repository = fakeRepository(
      cpfs.map((cpf) => row(cpf, 'desligado')),
      { failOnCall: 2 },
    );

    await expect(findDismissedCpfs(repository, cpfs)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(repository.calls.map((call) => call.length)).toEqual([HR_SWEEP_CHUNK_SIZE, 1]);
  });
});
