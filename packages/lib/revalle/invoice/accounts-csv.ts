export type ParsedAccount = {
  code: string;
  name: string;
  description: string;
  kind: 'PAYABLE' | 'RECEIVABLE' | null;
};

export type AccountsCsvResult = {
  accounts: ParsedAccount[];
  errors: { line: number; message: string }[];
};

const EXPECTED_HEADER = ['numero', 'nome', 'descricao', 'tipo'];

const splitRow = (row: string): string[] => {
  const cells: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < row.length; index++) {
    const char = row[index];

    if (quoted) {
      if (char === '"' && row[index + 1] === '"') {
        current += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ';') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  cells.push(current);

  return cells.map((cell) => cell.trim());
};

const normalizeHeader = (cell: string) => cell.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const parseKind = (value: string): ParsedAccount['kind'] | undefined => {
  const normalized = normalizeHeader(value);

  if (normalized === '') {
    return null;
  }

  if (normalized === 'pagar') {
    return 'PAYABLE';
  }

  if (normalized === 'receber') {
    return 'RECEIVABLE';
  }

  return undefined;
};

export const parseAccountsCsv = (text: string): AccountsCsvResult => {
  const accounts: ParsedAccount[] = [];
  const errors: AccountsCsvResult['errors'] = [];
  const seen = new Set<string>();

  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  let headerFound = false;

  for (const [index, rawLine] of lines.entries()) {
    const line = index + 1;

    if (rawLine.trim() === '') {
      continue;
    }

    const cells = splitRow(rawLine);

    if (!headerFound) {
      headerFound = true;

      if (!EXPECTED_HEADER.every((name, position) => normalizeHeader(cells[position] ?? '') === name)) {
        errors.push({ line, message: 'Cabeçalho inválido: use numero;nome;descricao;tipo' });
        break;
      }

      continue;
    }

    const [code = '', name = '', description = '', kindText = ''] = cells;

    if (code === '') {
      errors.push({ line, message: 'Falta o número da conta' });
      continue;
    }

    if (name === '') {
      errors.push({ line, message: 'Falta o nome da conta' });
      continue;
    }

    const kind = parseKind(kindText);

    if (kind === undefined) {
      errors.push({ line, message: 'Tipo inválido: use pagar, receber ou deixe em branco' });
      continue;
    }

    if (seen.has(code)) {
      errors.push({ line, message: `Número de conta repetido: ${code}` });
      continue;
    }

    seen.add(code);
    accounts.push({ code, name, description, kind });
  }

  if (!headerFound) {
    errors.push({ line: 1, message: 'O arquivo está vazio' });
  }

  return { accounts, errors };
};
