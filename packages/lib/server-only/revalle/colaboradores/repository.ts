import { Pool } from 'pg';
import {
  buildColaboradorSourceSql,
  COLABORADOR_FIELDS,
  missingRequiredFields,
  parseColumnOverrides,
  pickColaboradorColumns,
} from '../../../revalle/colaboradores-source';
import { normalizeCpf } from '../../../revalle/cpf';
import { env } from '../../../utils/env';
import { type Colaborador, mapColaboradorRow } from './map-row';

export type { Colaborador };

export type ColaboradoresRepository = {
  findByCpf(cpf: string): Promise<Colaborador | null>;
  findByEmail(email: string): Promise<Colaborador | null>;
  searchByName(query: string, limit?: number): Promise<Colaborador[]>;
};

const COLUMNS = COLABORADOR_FIELDS.join(', ');

// Padrão: a view do contrato (base de teste). Em produção, a tabela do RH direto, sem criar nada no banco dela.
const DEFAULT_TABLE = 'vw_colaboradores_assinatura';

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
    // A base é de outro sistema e o RevSign só consulta: a sessão recusa qualquer gravação, mesmo que o usuário da
    // conexão tenha permissão de escrita.
    options: '-c default_transaction_read_only=on',
  });

  pool.on('error', () => {
    console.error('[revalle] Erro em conexão ociosa da base de colaboradores.');
  });

  const queryRows = async (text: string, values: unknown[]) => {
    const result = await pool.query<Record<string, unknown>>(text, values);

    return result.rows;
  };

  const schema = env('COLABORADORES_SCHEMA')?.trim() || 'public';
  const table = env('COLABORADORES_TABLE')?.trim() || DEFAULT_TABLE;
  let source: Promise<string> | null = null;

  // Descobre as colunas uma vez (consulta só ao catálogo). Falhou: tenta de novo na próxima consulta.
  const resolveSource = async () => {
    const rows = await queryRows(
      `SELECT column_name AS name, data_type AS type FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
      [schema, table],
    );

    const mapping = pickColaboradorColumns(
      rows.map((row) => ({ name: String(row.name), type: String(row.type) })),
      parseColumnOverrides(env('COLABORADORES_COLUMNS')),
    );
    const missing = missingRequiredFields(mapping);

    if (rows.length === 0 || missing.length > 0) {
      // Só nomes de colunas e da tabela, nunca dados.
      console.error(
        `[revalle] Base de colaboradores: ${rows.length === 0 ? `tabela ${schema}.${table} não encontrada ou sem permissão` : `coluna não encontrada para ${missing.join(', ')}`}. Ajuste COLABORADORES_TABLE ou COLABORADORES_COLUMNS.`,
      );

      throw new Error('COLABORADORES_SOURCE_INVALID');
    }

    return buildColaboradorSourceSql(schema, table, mapping);
  };

  const getSource = async () => {
    source ??= resolveSource().catch((error: unknown) => {
      source = null;
      throw error;
    });

    return await source;
  };

  return {
    findByCpf: async (cpf) => {
      const rows = await queryRows(`SELECT ${COLUMNS} FROM ${await getSource()} AS c WHERE cpf = $1 LIMIT 1`, [
        normalizeCpf(cpf),
      ]);

      return rows[0] ? mapColaboradorRow(rows[0]) : null;
    },

    findByEmail: async (email) => {
      const rows = await queryRows(
        `SELECT ${COLUMNS} FROM ${await getSource()} AS c WHERE lower(trim(email)) = $1 LIMIT 1`,
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
        `SELECT ${COLUMNS} FROM ${await getSource()} AS c
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
