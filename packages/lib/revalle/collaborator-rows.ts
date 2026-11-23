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

const HEADER_NAMES: Record<string, Field> = { nome: 'name', email: 'email', cpf: 'cpf' };

const splitLine = (line: string, delimiter: string): string[] => {
  const cells: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  cells.push(current);

  return cells;
};

const pickDelimiter = (lines: string[]): string => {
  const sample = lines.find((line) => line.trim() !== '') ?? '';

  if (sample.includes('\t')) {
    return '\t';
  }

  const semicolons = sample.match(/;/g)?.length ?? 0;
  const commas = sample.match(/,/g)?.length ?? 0;

  return semicolons >= commas && semicolons > 0 ? ';' : ',';
};

const normalizeCpfCell = (value: string): string => {
  const digits = normalizeCpf(value);

  // Planilha que trata o CPF como número perde os zeros à esquerda.
  return digits.length >= 9 && digits.length < 11 ? digits.padStart(11, '0') : digits;
};

const buildRows = (table: { line: number; cells: string[] }[]): ParsedRow[] => {
  const filled = table.filter(({ cells }) => cells.some((cell) => String(cell ?? '').trim() !== ''));

  if (filled.length === 0) {
    return [];
  }

  const headerMap: Partial<Record<Field, number>> = {};

  filled[0].cells.forEach((cell, index) => {
    const field = HEADER_NAMES[fold(String(cell ?? ''))];

    if (field && headerMap[field] === undefined) {
      headerMap[field] = index;
    }
  });

  const hasHeader = Object.keys(headerMap).length > 0;
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
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const delimiter = pickDelimiter(lines);

  return buildRows(lines.map((line, index) => ({ line: index + 1, cells: splitLine(line, delimiter) })));
};

export const parseCollaboratorTable = (rows: string[][]): ParsedRow[] =>
  buildRows(rows.map((cells, index) => ({ line: index + 1, cells })));

export const estimateSendHours = (count: number, perHour: number): number => Math.ceil(count / perHour);

const INACTIVE_MARKERS = ['inativ', 'deslig', 'demit', 'rescis', 'falecid'];

/** Inativo no RH só quando a situação indica saída; ausente, "afastado" e "férias" contam como ativo. */
export const isInactiveSituacao = (situacao: string | null | undefined): boolean => {
  const folded = (situacao ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  return INACTIVE_MARKERS.some((marker) => folded.includes(marker));
};
