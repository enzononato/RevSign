// REVALLE (v.22): lê a planilha de colaboradores no navegador (.xlsx com read-excel-file, .csv com papaparse). O arquivo
// nunca sai do navegador: só as linhas lidas vão para a conferência (`previewRows`).

/** Limites da rota `previewRows` (colunas por linha e caracteres por célula). */
const MAX_COLUMNS = 50;
const MAX_CELL_LENGTH = 500;

export type SpreadsheetErrorCode = 'UNSUPPORTED' | 'OLD_EXCEL' | 'UNREADABLE' | 'EMPTY';

export class SpreadsheetError extends Error {
  constructor(public readonly code: SpreadsheetErrorCode) {
    super(code);
  }
}

const cellText = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '';
  }

  if (value instanceof Date) {
    return value.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
  }

  return String(value);
};

const fitRows = (rows: unknown[][]): string[][] =>
  rows.map((row) => row.slice(0, MAX_COLUMNS).map((cell) => cellText(cell).slice(0, MAX_CELL_LENGTH)));

/** CSV salvo pelo Excel em português costuma vir em Windows-1252: tenta UTF-8 primeiro. */
const decodeText = (buffer: ArrayBuffer): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
};

export const readSpreadsheetFile = async (file: File): Promise<string[][]> => {
  const name = file.name.toLowerCase();

  if (name.endsWith('.xls')) {
    throw new SpreadsheetError('OLD_EXCEL');
  }

  let rows: unknown[][];

  if (name.endsWith('.xlsx')) {
    try {
      const { readSheet } = await import('read-excel-file/browser');

      // Números como estão na célula (o CPF não vira 3.9e10).
      rows = await readSheet<string>(file, { parseNumber: (value) => value, trim: true });
    } catch {
      throw new SpreadsheetError('UNREADABLE');
    }
  } else if (name.endsWith('.csv') || name.endsWith('.txt') || file.type === 'text/csv') {
    try {
      const { default: Papa } = await import('papaparse');
      const parsed = Papa.parse<string[]>(decodeText(await file.arrayBuffer()).replace(/^\uFEFF/, ''), {
        // Linhas vazias ficam: o número da linha na conferência é o da planilha.
        skipEmptyLines: false,
        delimitersToGuess: [';', ',', '\t', '|'],
      });

      rows = parsed.data;
    } catch {
      throw new SpreadsheetError('UNREADABLE');
    }
  } else {
    throw new SpreadsheetError('UNSUPPORTED');
  }

  const table = fitRows(rows);

  if (!table.some((row) => row.some((cell) => cell.trim() !== ''))) {
    throw new SpreadsheetError('EMPTY');
  }

  return table;
};
