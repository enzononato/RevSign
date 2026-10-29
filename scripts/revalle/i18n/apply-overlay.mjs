#!/usr/bin/env node
// REVALLE: aplica o overlay pt-BR sobre o catálogo extraído do Lingui.
//   apply-overlay.mjs <po-base> <po-overlay>   grava o <po-base> no lugar
//   apply-overlay.mjs                          overlay revalle/pt-BR.po em todo packages/lib/translations/pt-BR/*.po
// O overlay vence (se o msgstr dele não for vazio). Nunca adiciona msgids que não existem no base;
// msgid do overlay ausente no base vira aviso "obsoleto". Cabeçalho e comentários do base ficam como estão.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyChanges, entryKey, excerpt, isHeader, readPo, serializePo } from './po.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const TRANSLATIONS = join(ROOT, 'packages/lib/translations');

export const applyOverlay = (basePath, overlayPath) => {
  const base = readPo(basePath);
  const overlay = readPo(overlayPath);
  const byKey = new Map(base.entries.filter((e) => !isHeader(e)).map((e) => [entryKey(e), e]));
  const changes = [];
  const stale = [];

  for (const o of overlay.entries) {
    if (isHeader(o) || o.msgstr === '') {
      continue;
    }

    const target = byKey.get(entryKey(o));

    if (!target) {
      stale.push(o);
      continue;
    }

    if (target.msgstr !== o.msgstr) {
      changes.push({ entry: target, msgstr: o.msgstr });
    }
  }

  applyChanges(base, changes);
  writeFileSync(basePath, serializePo(base));

  return { applied: changes.length, stale };
};

const main = () => {
  const args = process.argv.slice(2);
  let pairs;

  if (args.length === 2) {
    pairs = [[args[0], args[1]]];
  } else if (args.length === 0) {
    const overlay = join(TRANSLATIONS, 'revalle/pt-BR.po');
    const dir = join(TRANSLATIONS, 'pt-BR');
    const catalogs = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.po')) : [];

    pairs = catalogs.map((f) => [join(dir, f), overlay]);
  } else {
    console.error('uso: apply-overlay.mjs [<po-base> <po-overlay>]');
    process.exit(2);
  }

  for (const [base, overlay] of pairs) {
    const { applied, stale } = applyOverlay(base, overlay);

    console.log(`[overlay] ${base}: ${applied} entradas aplicadas, ${stale.length} do overlay obsoletas (ignoradas)`);

    for (const s of stale) {
      console.log(`  aviso: ${overlay}:${s.line}: obsoleto (msgid não existe no base): "${excerpt(s.msgid)}"`);
    }
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
