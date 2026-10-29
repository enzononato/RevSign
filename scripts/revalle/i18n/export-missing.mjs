#!/usr/bin/env node
// REVALLE: lista as entradas que faltam traduzir (msgstr vazio ou com "Documenso") em JSON:
//   export-missing.mjs <po> [--batch N --size 150] > missing.json
// Ordem determinística (primeira referência, depois msgid); --batch é 1-based.
import { fileURLToPath } from 'node:url';

import { isHeader, readPo } from './po.mjs';

export const missingEntries = (file) =>
  readPo(file)
    .entries.filter((e) => !isHeader(e) && (e.msgstr === '' || e.msgstr.includes('Documenso')))
    .map((e) => ({
      msgid: e.msgid,
      ...(e.msgctxt === undefined ? {} : { msgctxt: e.msgctxt }),
      references: e.references,
      current: e.msgstr,
    }))
    .sort((a, b) => {
      const ra = a.references[0] ?? '';
      const rb = b.references[0] ?? '';

      if (ra !== rb) {
        return ra < rb ? -1 : 1;
      }

      return a.msgid < b.msgid ? -1 : a.msgid > b.msgid ? 1 : 0;
    });

const main = () => {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);

    return i === -1 ? undefined : args.splice(i, 2)[1];
  };
  const batch = opt('--batch');
  const size = Number(opt('--size') ?? 150);
  const file = args[0];

  if (!file) {
    console.error('uso: export-missing.mjs <po> [--batch N --size 150]');
    process.exit(2);
  }

  let list = missingEntries(file);

  if (batch !== undefined) {
    const n = Number(batch);

    list = list.slice((n - 1) * size, n * size);
  }

  process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
