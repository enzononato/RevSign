#!/usr/bin/env node
// REVALLE: valida um catálogo .po traduzido (falha o build se uma tradução quebraria a tela em runtime).
//   check-po.mjs [--locale pt-BR] [--warn-missing] [--overlay <po>] [<po>...]
// Erros (exit 1): {placeholders} diferentes, tags <n></n><n/> com contagem diferente, ICU sem a mesma
// palavra-chave ou plural sem `other`, "Documenso" no msgstr (salvo allowlist), e vazios sem --warn-missing.
// Overlay com msgid que não está no base é só aviso "obsoleto" (upgrade do upstream não quebra o build).
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { entryKey, excerpt, isHeader, readPo } from './po.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const TRANSLATIONS = join(ROOT, 'packages/lib/translations');

// msgids em que "Documenso" pode continuar na tradução (regra 8: link do código-fonte e avisos de licença).
export const DOCUMENSO_ALLOWLIST = [/Código-fonte/i, /\bAGPL\b/, /\blicen[sc]e\b/i, /\blicença\b/i];

const ICU_TYPES = ['plural', 'select', 'selectordinal'];

const matchBrace = (s, open) => {
  let depth = 0;

  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') {
      depth++;
    } else if (s[i] === '}' && --depth === 0) {
      return i;
    }
  }

  return -1;
};

// Extrai nomes de argumentos e palavras-chave ICU (com seus seletores), recursivamente.
export const analyzeIcu = (msg, out = { names: new Set(), types: new Set(), selectors: new Map() }) => {
  let i = 0;

  while (i < msg.length) {
    if (msg[i] !== '{') {
      i++;
      continue;
    }

    const end = matchBrace(msg, i);

    if (end === -1) {
      out.names.add('<chave não fechada>');
      break;
    }

    const inner = msg.slice(i + 1, end);
    const m = inner.match(/^\s*([\w.]+)\s*(?:,\s*(plural|select|selectordinal)\s*,([\s\S]*))?$/);

    if (m) {
      out.names.add(m[1]);

      if (m[2]) {
        out.types.add(m[2]);
        const selectors = out.selectors.get(m[2]) ?? new Set();
        out.selectors.set(m[2], selectors);
        let rest = m[3];

        for (;;) {
          const b = rest.match(/^\s*([^\s{]+)\s*\{/);

          if (!b) {
            break;
          }

          selectors.add(b[1]);
          const open = b[0].length - 1;
          const close = matchBrace(rest, open);

          if (close === -1) {
            break;
          }

          analyzeIcu(rest.slice(open + 1, close), out);
          rest = rest.slice(close + 1);
        }
      }
    } else {
      analyzeIcu(inner, out);
    }

    i = end + 1;
  }

  return out;
};

const tagCounts = (s) => {
  const counts = new Map();
  const add = (key) => counts.set(key, (counts.get(key) ?? 0) + 1);

  for (const m of s.matchAll(/<(\/?)(\d+)(\/?)>/g)) {
    add(m[3] ? `<${m[2]}/>` : m[1] ? `</${m[2]}>` : `<${m[2]}>`);
  }

  return counts;
};

const diffSets = (a, b) => [[...a].filter((x) => !b.has(x)), [...b].filter((x) => !a.has(x))];

export const checkEntry = (entry) => {
  const problems = [];
  const src = analyzeIcu(entry.msgid);
  const dst = analyzeIcu(entry.msgstr);
  const [missing, extra] = diffSets(src.names, dst.names);

  if (missing.length || extra.length) {
    problems.push(
      `placeholders diferentes${missing.length ? `; faltam {${missing.join('}, {')}}` : ''}${extra.length ? `; sobram {${extra.join('}, {')}}` : ''}`,
    );
  }

  const tagsA = tagCounts(entry.msgid);
  const tagsB = tagCounts(entry.msgstr);

  for (const key of new Set([...tagsA.keys(), ...tagsB.keys()])) {
    if ((tagsA.get(key) ?? 0) !== (tagsB.get(key) ?? 0)) {
      problems.push(`tag ${key}: ${tagsA.get(key) ?? 0} no original, ${tagsB.get(key) ?? 0} na tradução`);
    }
  }

  for (const type of ICU_TYPES) {
    if (src.types.has(type) !== dst.types.has(type)) {
      problems.push(`ICU ${type}: ${src.types.has(type) ? 'falta na tradução' : 'não existe no original'}`);
    }
  }

  for (const type of ['plural', 'selectordinal']) {
    if (dst.types.has(type) && !dst.selectors.get(type).has('other')) {
      problems.push(`ICU ${type} sem o ramo "other"`);
    }
  }

  if (entry.msgstr.includes('Documenso') && !DOCUMENSO_ALLOWLIST.some((re) => re.test(entry.msgid))) {
    problems.push('a tradução contém "Documenso" (trocar por RevSign)');
  }

  return problems;
};

export const checkFile = (file, { warnMissing }) => {
  const po = readPo(file);
  const errors = [];
  const warnings = [];
  let missing = 0;

  for (const e of po.entries) {
    if (isHeader(e)) {
      continue;
    }

    if (e.msgstr === '') {
      missing++;
      (warnMissing ? warnings : errors).push({ line: e.line, msgid: e.msgid, text: 'sem tradução' });
      continue;
    }

    for (const text of checkEntry(e)) {
      errors.push({ line: e.line, msgid: e.msgid, text });
    }
  }

  return { po, errors, warnings, missing };
};

const main = () => {
  const args = process.argv.slice(2);
  const warnMissing = args.includes('--warn-missing');
  const opt = (name) => {
    const i = args.indexOf(name);

    return i === -1 ? undefined : args.splice(i, 2)[1];
  };
  const locale = opt('--locale');
  const overlay = opt('--overlay');
  const files = args.filter((a) => !a.startsWith('--'));

  if (locale) {
    const dir = join(TRANSLATIONS, locale);

    files.push(
      ...(existsSync(dir)
        ? readdirSync(dir)
            .filter((f) => f.endsWith('.po'))
            .map((f) => join(dir, f))
        : []),
    );
  }

  if (files.length === 0) {
    console.error('uso: check-po.mjs [--locale pt-BR] [--warn-missing] [--overlay <po>] [<po>...]');
    process.exit(2);
  }

  const overlayPath = overlay ?? (locale ? join(TRANSLATIONS, 'revalle', `${locale}.po`) : undefined);
  let totalErrors = 0;

  for (const file of files) {
    const { po, errors, warnings, missing } = checkFile(file, { warnMissing });

    for (const w of warnings) {
      console.log(`${file}:${w.line}: aviso: "${excerpt(w.msgid)}": ${w.text}`);
    }

    for (const e of errors) {
      console.log(`${file}:${e.line}: erro: "${excerpt(e.msgid)}": ${e.text}`);
    }

    console.log(
      `[check-po] ${file}: ${po.entries.length - 1} entradas, ${missing} sem tradução${warnMissing ? ' (aviso)' : ''}, ${errors.length - (warnMissing ? 0 : missing)} erros de conteúdo`,
    );
    totalErrors += errors.length;

    if (overlayPath && existsSync(overlayPath)) {
      const keys = new Set(po.entries.map(entryKey));

      for (const o of readPo(overlayPath).entries) {
        if (!isHeader(o) && !keys.has(entryKey(o))) {
          console.log(
            `${overlayPath}:${o.line}: aviso: "${excerpt(o.msgid)}": obsoleto (msgid não existe no catálogo)`,
          );
        }
      }
    }
  }

  process.exit(totalErrors > 0 ? 1 : 0);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
