/**
 * Leitura da base de colaboradores sem criar nada no banco dela: os nomes reais das colunas são descobertos pelo
 * catálogo (`information_schema`) e convertidos para o contrato do RevSign dentro da própria consulta.
 */

export const COLABORADOR_FIELDS = [
  'cpf',
  'nome',
  'data_nascimento',
  'cargo',
  'setor',
  'unidade',
  'matricula',
  'email',
  'telefone',
  'situacao',
] as const;

export type ColaboradorField = (typeof COLABORADOR_FIELDS)[number];

export const REQUIRED_COLABORADOR_FIELDS: ColaboradorField[] = ['cpf', 'nome', 'data_nascimento'];

// Do mais específico para o mais genérico; a primeira coluna existente vence.
const CANDIDATES: Record<ColaboradorField, string[]> = {
  cpf: ['cpf', 'cpf_completo', 'nr_cpf', 'nu_cpf', 'num_cpf', 'cpf_colaborador', 'documento'],
  nome: ['nome_completo', 'nome', 'nome_colaborador', 'nome_funcionario', 'colaborador', 'funcionario', 'name'],
  data_nascimento: [
    'data_nascimento',
    'dt_nascimento',
    'datanascimento',
    'dtnascimento',
    'nascimento',
    'data_nasc',
    'dt_nasc',
    'birth_date',
    'birthdate',
  ],
  cargo: ['cargo', 'cargo_nome', 'funcao', 'cargo_funcao', 'cargo_descricao', 'des_funcao'],
  setor: ['setor', 'setor_nome', 'departamento', 'area', 'secao', 'lotacao', 'des_setor'],
  unidade: ['unidade', 'unidade_nome', 'revenda', 'filial', 'empresa', 'loja', 'des_unidade'],
  matricula: ['matricula', 'matricula_rh', 'registro', 'cod_funcionario', 'codigo_funcionario'],
  email: ['email', 'email_corp', 'email_corporativo', 'e_mail', 'email_empresa'],
  telefone: ['telefone', 'celular', 'fone', 'whatsapp', 'tel'],
  situacao: ['situacao', 'status', 'status_rh', 'status_colaborador', 'des_situacao', 'ativo'],
};

export type CatalogColumn = { name: string; type: string };

export type ColaboradorMapping = Partial<Record<ColaboradorField, CatalogColumn>>;

const normalizeName = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_');

/**
 * `overrides` vem de `COLABORADORES_COLUMNS` (`campo=coluna,campo=coluna`) e vence a detecção. Coluna inexistente no
 * catálogo é ignorada, para um erro de digitação não virar SQL inválido.
 */
export const pickColaboradorColumns = (
  columns: CatalogColumn[],
  overrides: Partial<Record<ColaboradorField, string>> = {},
): ColaboradorMapping => {
  const byNormalized = new Map(columns.map((column) => [normalizeName(column.name), column]));
  const byExact = new Map(columns.map((column) => [column.name, column]));
  const mapping: ColaboradorMapping = {};

  for (const field of COLABORADOR_FIELDS) {
    const override = overrides[field];
    const chosen = override
      ? (byExact.get(override) ?? byNormalized.get(normalizeName(override)))
      : CANDIDATES[field].map((candidate) => byNormalized.get(candidate)).find(Boolean);

    if (chosen) {
      mapping[field] = chosen;
    }
  }

  return mapping;
};

export const parseColumnOverrides = (raw: string | undefined): Partial<Record<ColaboradorField, string>> => {
  const overrides: Partial<Record<ColaboradorField, string>> = {};

  for (const pair of (raw ?? '').split(',')) {
    const [field, column] = pair.split('=').map((part) => part.trim());

    if (field && column && (COLABORADOR_FIELDS as readonly string[]).includes(field)) {
      overrides[field as ColaboradorField] = column;
    }
  }

  return overrides;
};

export const missingRequiredFields = (mapping: ColaboradorMapping) =>
  REQUIRED_COLABORADOR_FIELDS.filter((field) => !mapping[field]);

export const quoteIdentifier = (name: string) => `"${name.replace(/"/g, '""')}"`;

const isDateType = (type: string) => /^(date|timestamp)/i.test(type);

// Texto em dd/mm/aaaa ou aaaa-mm-dd vira aaaa-mm-dd; qualquer outra coisa vira nulo (não confere com nada).
const birthDateExpression = (column: CatalogColumn) => {
  const ref = `t.${quoteIdentifier(column.name)}`;

  if (isDateType(column.type)) {
    return `to_char(${ref}, 'YYYY-MM-DD')`;
  }

  const text = `btrim(${ref}::text)`;

  return `CASE
      WHEN ${text} ~ '^\\d{2}/\\d{2}/\\d{4}' THEN substr(${text}, 7, 4) || '-' || substr(${text}, 4, 2) || '-' || substr(${text}, 1, 2)
      WHEN ${text} ~ '^\\d{4}-\\d{2}-\\d{2}' THEN substr(${text}, 1, 10)
      ELSE NULL
    END`;
};

const fieldExpression = (field: ColaboradorField, column: CatalogColumn | undefined) => {
  if (!column) {
    return `NULL::text`;
  }

  const ref = `t.${quoteIdentifier(column.name)}`;

  if (field === 'cpf') {
    return `regexp_replace(${ref}::text, '\\D', '', 'g')`;
  }

  if (field === 'data_nascimento') {
    return birthDateExpression(column);
  }

  return `${ref}::text`;
};

/**
 * Subconsulta com as colunas do contrato (`cpf` só dígitos, `data_nascimento` em aaaa-mm-dd, o resto em texto), para
 * usar como `FROM (...) AS c`. Os nomes vêm do catálogo e entram sempre entre aspas.
 */
export const buildColaboradorSourceSql = (schema: string, table: string, mapping: ColaboradorMapping) => {
  const select = COLABORADOR_FIELDS.map((field) => `${fieldExpression(field, mapping[field])} AS ${field}`).join(
    ',\n    ',
  );

  return `(SELECT\n    ${select}\n  FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)} t)`;
};
