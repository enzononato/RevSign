import { normalizeCpf } from './cpf';

export type ParsedRow = { line: number; name: string; email: string; cpf: string };

export type RowIssue =
  | 'E-mail inválido'
  | 'CPF inválido'
  | 'CPF não está na base do RH'
  | 'Colaborador inativo no RH'
  | 'CPF repetido na lista'
  | 'E-mail repetido na lista';

export type PreviewRow = ParsedRow & { hrName: string | null; issues: RowIssue[] };

export type PreviewResult = { rows: PreviewRow[]; ready: number; withErrors: number; duplicates: number };

export const MAX_COLLABORATOR_ROWS = 3000;

const fold = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
    .trim();

type Field = 'name' | 'email' | 'cpf';

type RawRow = { line: number; cells: string[] };

/** Leitura caractere a caractere: campo entre aspas pode ter delimitador e quebra de linha (Alt+Enter do Excel). */
const tokenize = (text: string, delimiter: string): RawRow[] => {
  const rows: RawRow[] = [];
  let cells: string[] = [];
  let current = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;

  const endRow = () => {
    cells.push(current);
    rows.push({ line: rowLine, cells });
    cells = [];
    current = '';
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        if (char === '\n') {
          line += 1;
        }

        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      cells.push(current);
      current = '';
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') {
        index += 1;
      }

      endRow();
      line += 1;
      rowLine = line;
    } else {
      current += char;
    }
  }

  if (current !== '' || cells.length > 0) {
    endRow();
  }

  return rows;
};

const isBlank = (row: RawRow) => row.cells.every((cell) => String(cell ?? '').trim() === '');

const DELIMITERS = ['\t', ';', ','];

const pickDelimiter = (text: string): string => {
  let best = { delimiter: ',', score: -1, width: 0 };

  for (const delimiter of DELIMITERS) {
    const sample = tokenize(text, delimiter)
      .filter((row) => !isBlank(row))
      .slice(0, 5);
    const counts = new Map<number, number>();

    for (const row of sample) {
      counts.set(row.cells.length, (counts.get(row.cells.length) ?? 0) + 1);
    }

    let width = 0;
    let score = 0;

    for (const [count, rows] of counts) {
      if (rows > score || (rows === score && count > width)) {
        width = count;
        score = rows;
      }
    }

    // Só vale quem separa em 3 colunas ou mais; empate fica com tab, depois ';', depois ','.
    const effective = width >= 3 ? score : 0;

    if (effective > best.score || (effective === best.score && effective === 0 && width > best.width)) {
      best = { delimiter, score: effective, width };
    }
  }

  return best.delimiter;
};

const normalizeCpfCell = (value: string): string => {
  const digits = normalizeCpf(value);

  // Planilha que trata o CPF como número perde os zeros à esquerda.
  return digits.length >= 9 && digits.length < 11 ? digits.padStart(11, '0') : digits;
};

const matchField = (header: string): Field | null => {
  if (header.startsWith('nome')) {
    return 'name';
  }

  if (header.includes('mail')) {
    return 'email';
  }

  if (header.startsWith('cpf')) {
    return 'cpf';
  }

  return null;
};

const buildRows = (table: RawRow[]): ParsedRow[] => {
  const filled = table.filter((row) => !isBlank(row));

  if (filled.length === 0) {
    return [];
  }

  const headerMap: Partial<Record<Field, number>> = {};

  filled[0].cells.forEach((cell, index) => {
    const field = matchField(fold(String(cell ?? '')));

    if (field && headerMap[field] === undefined) {
      headerMap[field] = index;
    }
  });

  const hasHeader = Object.keys(headerMap).length >= 2;
  const columns: Record<Field, number> = hasHeader
    ? { name: headerMap.name ?? -1, email: headerMap.email ?? -1, cpf: headerMap.cpf ?? -1 }
    : { name: 0, email: 1, cpf: 2 };
  const dataRows = hasHeader ? filled.slice(1) : filled;

  if (dataRows.length > MAX_COLLABORATOR_ROWS) {
    throw new Error('ROW_LIMIT');
  }

  const read = (cells: string[], index: number) => (index < 0 ? '' : String(cells[index] ?? '').trim());

  return dataRows.map(({ line, cells }) => ({
    line,
    name: read(cells, columns.name),
    email: read(cells, columns.email),
    cpf: normalizeCpfCell(read(cells, columns.cpf)),
  }));
};

export const parseCollaboratorText = (text: string): ParsedRow[] => {
  const clean = text.replace(/^\uFEFF/, '');

  return buildRows(tokenize(clean, pickDelimiter(clean)));
};

export const parseCollaboratorTable = (rows: string[][]): ParsedRow[] =>
  buildRows(rows.map((cells, index) => ({ line: index + 1, cells })));

export const estimateSendHours = (count: number, perHour: number): number => Math.ceil(count / perHour);

const INACTIVE_EXACT = new Set(['false', 'f', 'n', 'nao', '0']);
const INACTIVE_MARKERS = ['inativ', 'deslig', 'demit', 'rescis', 'falecid'];

/** Inativo no RH só quando a situação indica saída; ausente, "afastado" e "férias" contam como ativo. */
export const isInactiveSituacao = (situacao: string | null | undefined): boolean => {
  const folded = (situacao ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  if (INACTIVE_EXACT.has(folded.trim())) {
    return true;
  }

  return INACTIVE_MARKERS.some((marker) => folded.includes(marker));
};
