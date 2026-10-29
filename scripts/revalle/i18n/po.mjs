// REVALLE: parser/serializador mínimo de .po (sem dependências). Mantém as linhas originais, então
// ler e gravar sem mudanças devolve o arquivo byte a byte. Só o msgstr de uma entrada é reescrito.
import { readFileSync } from 'node:fs';

const unquote = (line) => {
  const body = line.slice(line.indexOf('"') + 1, line.lastIndexOf('"'));

  return body.replace(/\\(["\\nt])/g, (_, c) => ({ n: '\n', t: '\t', '"': '"', '\\': '\\' })[c]);
};

export const quote = (value) =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;

// Serializa um msgstr no formato do Lingui: uma linha, ou várias (a primeira vazia) se houver "\n" no meio.
export const msgstrLines = (value) => {
  if (!value.includes('\n') || value.indexOf('\n') === value.length - 1) {
    return [`msgstr ${quote(value)}`];
  }

  const parts = value.split(/(?<=\n)/);

  return ['msgstr ""', ...parts.map((p) => quote(p))];
};

export const parsePo = (text) => {
  const lines = text.split('\n');
  const entries = [];
  let cur = null;
  let field = null;

  const flush = () => {
    if (cur) {
      entries.push(cur);
    }

    cur = null;
    field = null;
  };

  const begin = (i) => {
    cur = { line: i + 1, references: [], msgctxt: undefined, msgid: '', msgstr: '', strStart: -1, strEnd: -1 };
  };

  lines.forEach((line, i) => {
    if (line.trim() === '') {
      flush();

      return;
    }

    if (line.startsWith('#~')) {
      return;
    }

    if (line.startsWith('#')) {
      if (cur && cur.strStart !== -1) {
        flush();
      }

      if (!cur) {
        begin(i);
      }

      if (line.startsWith('#:')) {
        cur.references.push(...line.slice(2).trim().split(/\s+/).filter(Boolean));
      }

      return;
    }

    if (/^msg(ctxt|id|str)\s/.test(line)) {
      const key = line.match(/^msg(ctxt|id|str)/)[0];

      if (key === 'msgctxt' && cur && cur.strStart !== -1) {
        flush();
      }

      if (key === 'msgid' && cur && cur.strStart !== -1) {
        flush();
      }

      if (!cur) {
        begin(i);
      }

      if (key === 'msgctxt') {
        cur.msgctxt = '';
      }

      field = key;

      if (key === 'msgstr') {
        cur.strStart = i;
      }

      cur.dataLine ??= i + 1;
      appendValue(cur, key, unquote(line));

      if (key === 'msgstr') {
        cur.strEnd = i;
      }

      return;
    }

    if (line.startsWith('"') && cur && field) {
      appendValue(cur, field, unquote(line));

      if (field === 'msgstr') {
        cur.strEnd = i;
      }
    }
  });

  flush();

  return { lines, entries };
};

const appendValue = (entry, key, value) => {
  entry[key] = (entry[key] ?? '') + value;
};

export const readPo = (file) => ({ file, ...parsePo(readFileSync(file, 'utf8')) });

export const serializePo = ({ lines }) => lines.join('\n');

export const entryKey = (e) => `${e.msgctxt ?? ''}\u0004${e.msgid}`;

export const isHeader = (e) => e.msgid === '' && e.msgctxt === undefined;

// Troca o msgstr de uma entrada (por índice); chame com as entradas de trás para frente ou use applyChanges.
export const applyChanges = (po, changes) => {
  const sorted = [...changes].sort((a, b) => b.entry.strStart - a.entry.strStart);

  for (const { entry, msgstr } of sorted) {
    po.lines.splice(entry.strStart, entry.strEnd - entry.strStart + 1, ...msgstrLines(msgstr));
  }

  return po;
};

export const excerpt = (s, n = 70) => {
  const one = s.replace(/\s+/g, ' ');

  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
