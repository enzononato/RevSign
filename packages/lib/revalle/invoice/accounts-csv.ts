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

type CsvRecord = { line: number; cells: string[]; unterminated: boolean };

const splitRecords = (text: string): CsvRecord[] => {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let current = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;

  const endRecord = (unterminated: boolean) => {
    cells.push(current);
    records.push({ line: recordLine, cells: cells.map((cell) => cell.trim()), unterminated });
    cells = [];
    current = '';
  };

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        current += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        if (char === '\n') {
          line++;
        }

        current += char;
      }

      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ';') {
      cells.push(current);
      current = '';
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') {
        index++;
      }

      endRecord(false);
      line++;
      recordLine = line;
    } else {
      current += char;
    }
  }

  if (quoted) {
    endRecord(true);
  } else if (current !== '' || cells.length > 0) {
    endRecord(false);
  }

  return records;
};

export const decodeCsvBytes = (bytes: Uint8Array): { text: string; encoding: 'utf-8' | 'windows-1252' } => {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
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

  const content = text.replace(/^\uFEFF/, '');

  if (content.includes('\uFFFD')) {
    return {
      accounts,
      errors: [{ line: 1, message: 'Salve o arquivo como CSV UTF-8 (no Excel: Salvar como → CSV UTF-8).' }],
    };
  }

  let headerFound = false;

  for (const { line, cells, unterminated } of splitRecords(content)) {
    if (unterminated) {
      errors.push({ line, message: 'Aspas sem fechar' });
      break;
    }

    if (cells.every((cell) => cell === '')) {
      continue;
    }

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

  if (!headerFound && errors.length === 0) {
    errors.push({ line: 1, message: 'O arquivo está vazio' });
  }

  return { accounts, errors };
};
