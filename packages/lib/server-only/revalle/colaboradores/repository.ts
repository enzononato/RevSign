import { Pool } from 'pg';
import { normalizeCpf } from '../../../revalle/cpf';
import { env } from '../../../utils/env';
import { type Colaborador, mapColaboradorRow } from './map-row';

export type { Colaborador };

export type ColaboradoresRepository = {
  findByCpf(cpf: string): Promise<Colaborador | null>;
  findByEmail(email: string): Promise<Colaborador | null>;
  searchByName(query: string, limit?: number): Promise<Colaborador[]>;
};

const VIEW_COLUMNS = `cpf, nome, to_char(data_nascimento, 'YYYY-MM-DD') AS data_nascimento,
  cargo, setor, unidade, matricula, email, telefone, situacao`;

const ACCENTS_FROM = 'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ';
const ACCENTS_TO = 'aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN';

// Sem a extensão unaccent: a base real não é nossa para instalar extensões.
const FOLD = (expr: string) => `lower(translate(${expr}, '${ACCENTS_FROM}', '${ACCENTS_TO}'))`;

const foldJs = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

const DEFAULT_SEARCH_LIMIT = 8;

let repository: ColaboradoresRepository | null = null;

const createRepository = (connectionString: string): ColaboradoresRepository => {
  const pool = new Pool({
    connectionString,
    max: 5,
    statement_timeout: 5000,
    query_timeout: 5000,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });

  pool.on('error', () => {
    console.error('[revalle] Erro em conexão ociosa da base de colaboradores.');
  });

  const queryRows = async (text: string, values: unknown[]) => {
    const result = await pool.query<Record<string, unknown>>(text, values);

    return result.rows;
  };

  return {
    findByCpf: async (cpf) => {
      const rows = await queryRows(`SELECT ${VIEW_COLUMNS} FROM vw_colaboradores_assinatura WHERE cpf = $1 LIMIT 1`, [
        normalizeCpf(cpf),
      ]);

      return rows[0] ? mapColaboradorRow(rows[0]) : null;
    },

    findByEmail: async (email) => {
      const rows = await queryRows(
        `SELECT ${VIEW_COLUMNS} FROM vw_colaboradores_assinatura WHERE lower(trim(email)) = $1 LIMIT 1`,
        [email.trim().toLowerCase()],
      );

      return rows[0] ? mapColaboradorRow(rows[0]) : null;
    },

    searchByName: async (query, limit = DEFAULT_SEARCH_LIMIT) => {
      const term = foldJs(query);

      if (!term) {
        return [];
      }

      const rows = await queryRows(
        `SELECT ${VIEW_COLUMNS} FROM vw_colaboradores_assinatura
         WHERE ${FOLD('nome')} LIKE $1 ESCAPE '\\'
         ORDER BY nome
         LIMIT $2`,
        [`%${escapeLike(term)}%`, Math.max(1, Math.floor(limit))],
      );

      return rows.map(mapColaboradorRow);
    },
  };
};

export const getColaboradoresRepository = (): ColaboradoresRepository | null => {
  const url = env('COLABORADORES_DATABASE_URL');

  if (!url) {
    return null;
  }

  repository ??= createRepository(url);

  return repository;
};
