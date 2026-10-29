// REVALLE: overlay pt-BR e validador de .po (Task 2a, Fase 2). Puro: roda os scripts em fixtures pequenas.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FX = join(here, 'fixtures/i18n');
const SCRIPTS = join(here, '../i18n');

const run = (script, args) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: 'utf8' });
const check = (name, extra = []) => run('check-po.mjs', [join(FX, `${name}.po`), ...extra]);

test('check-po: entrada boa passa', () => {
  assert.equal(check('ok-placeholder').status, 0);
  assert.equal(check('ok-plural').status, 0);
});

test('check-po: placeholder perdido é erro', () => {
  const r = check('bad-placeholder');
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /name/);
  assert.match(r.stdout + r.stderr, /bad-placeholder\.po:\d+/);
});

test('check-po: tag <0> perdida é erro', () => {
  const r = check('bad-tag');
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /tag/i);
});

test('check-po: plural sem other é erro', () => {
  const r = check('bad-plural');
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /other/);
});

test('check-po: Documenso na tradução é erro', () => {
  const r = check('bad-documenso');
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /Documenso/);
});

test('check-po: vazio é erro, ou aviso com --warn-missing', () => {
  assert.equal(check('missing').status, 1);
  const r = check('missing', ['--warn-missing']);
  assert.equal(r.status, 0);
  assert.match(r.stdout + r.stderr, /1 sem tradução/);
});

test('check-po: msgid com Documenso sem tradução é erro mesmo com --warn-missing (salvo licença)', () => {
  const r = check('missing-documenso', ['--warn-missing']);
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 1);
  assert.match(out, /missing-documenso\.po:\d+: erro: "Welcome to Documenso"/);
  assert.doesNotMatch(out, /erro: "Documenso is licensed/);
  assert.match(out, /aviso: "Sign in": sem tradução/);
});

test('check-po: resumo de uma linha no fim (entradas, sem tradução, obsoletas, erros)', () => {
  const r = run('check-po.mjs', [
    join(FX, 'missing-documenso.po'),
    join(FX, 'ok-placeholder.po'),
    '--warn-missing',
    '--overlay',
    join(FX, 'stale.po'),
  ]);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.at(-1), '[check-po] resumo: 4 entradas, 3 sem tradução, 1 obsoletas no overlay, 1 erros');
  assert.equal(
    check('ok-placeholder').stdout.trim().split('\n').at(-1),
    '[check-po] resumo: 1 entradas, 0 sem tradução, 0 obsoletas no overlay, 0 erros',
  );
});

test('check-po: Código-fonte e aviso de licença podem citar Documenso', () => {
  const dir = mkdtempSync(join(tmpdir(), 'po-'));
  const file = join(dir, 'a.po');
  writeFileSync(
    file,
    'msgid ""\nmsgstr ""\n\nmsgid "Source code (AGPL-3.0) Documenso"\nmsgstr "Código-fonte (AGPL-3.0) Documenso"\n',
  );
  assert.equal(run('check-po.mjs', [file]).status, 0);
});

const applyTo = (overlay = 'overlay.po') => {
  const dir = mkdtempSync(join(tmpdir(), 'po-'));
  const base = join(dir, 'base.po');
  copyFileSync(join(FX, 'base.po'), base);
  const r = run('apply-overlay.mjs', [base, join(FX, overlay)]);
  return { r, out: readFileSync(base, 'utf8') };
};

test('apply-overlay: sobrescreve entrada existente (inclusive com msgctxt e aspas escapadas)', () => {
  const { r, out } = applyTo();
  assert.equal(r.status, 0);
  assert.match(out, /msgstr "Feito com RevSign"/);
  assert.match(out, /msgstr "Bem-vindo \{0\}, \\"amigo\\""/);
  assert.match(out, /msgctxt "Audit log format"\nmsgid "Sent"\nmsgstr "Enviado"/);
  assert.match(out, /msgid "Hello \{name\}"\nmsgstr "Olá \{name\}"/);
});

test('apply-overlay: ignora msgid inexistente (aviso obsoleto) e nunca o adiciona', () => {
  const { r, out } = applyTo();
  assert.doesNotMatch(out, /Not in base/);
  assert.match(r.stdout + r.stderr, /obsoleto/);
});

test('apply-overlay: mantém cabeçalho, comentários e entradas multi-linha', () => {
  const { out } = applyTo();
  assert.ok(out.startsWith('msgid ""\nmsgstr ""\n"Content-Type'));
  assert.match(out, /#\. placeholder \{0\}: user\.name\n#: apps\/b\.tsx/);
  assert.match(out, /msgid ""\n"Long text "\n"continues here"\nmsgstr ""\n"Texto longo "/);
});

test('apply-overlay: sem overlay o arquivo fica byte a byte igual', () => {
  const empty = join(mkdtempSync(join(tmpdir(), 'po-')), 'empty.po');
  writeFileSync(empty, 'msgid ""\nmsgstr ""\n');
  const dir = mkdtempSync(join(tmpdir(), 'po-'));
  const base = join(dir, 'base.po');
  copyFileSync(join(FX, 'base.po'), base);
  assert.equal(run('apply-overlay.mjs', [base, empty]).status, 0);
  assert.equal(readFileSync(base, 'utf8'), readFileSync(join(FX, 'base.po'), 'utf8'));
});

test('check-po: overlay obsoleto só avisa (exit 0)', () => {
  const r = run('check-po.mjs', [join(FX, 'ok-placeholder.po'), '--overlay', join(FX, 'stale.po')]);
  assert.equal(r.status, 0);
  assert.match(r.stdout + r.stderr, /obsoleto/);
});

test('export-missing: vazios e Documenso, ordenados, com lotes', () => {
  const all = JSON.parse(run('export-missing.mjs', [join(FX, 'base.po')]).stdout);
  assert.deepEqual(
    all.map((e) => e.references[0]),
    ['apps/b.tsx', 'apps/c.tsx', 'apps/d.tsx', 'apps/f.tsx'],
  );
  assert.equal(all.length, 4);
  assert.equal(all.find((e) => e.msgid === 'Sent').msgctxt, 'Audit log format');
  assert.deepEqual(all[0].references, ['apps/b.tsx']);
  assert.equal(all.find((e) => e.msgid === 'Powered by Documenso').current, 'Feito com Documenso');
  const b1 = JSON.parse(run('export-missing.mjs', [join(FX, 'base.po'), '--batch', '1', '--size', '2']).stdout);
  const b3 = JSON.parse(run('export-missing.mjs', [join(FX, 'base.po'), '--batch', '2', '--size', '3']).stdout);
  assert.equal(b1.length, 2);
  assert.equal(b3.length, 1);
  assert.deepEqual(b1, all.slice(0, 2));
});

// Guarda do pre-commit (check-secrets.sh --staged): catálogo do upstream no stage só passa num merge ou com a variável.
test('check-secrets: bloqueia web.po do upstream no stage; overlay, merge e REVALLE_ALLOW_UPSTREAM_PO=1 passam', () => {
  const repo = mkdtempSync(join(tmpdir(), 'guard-'));
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  const guard = (env = {}) =>
    spawnSync('sh', [join(here, '../check-secrets.sh'), '--staged'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  const write = (path, text) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const BLOCKED = /catálogos do upstream no stage/;

  git('init', '-q');
  git('config', 'user.email', 'teste@revalle.com.br');
  git('config', 'user.name', 'Teste');
  write('README', 'x\n');
  git('add', 'README');
  git('commit', '-q', '-m', 'init');

  write('packages/lib/translations/revalle/pt-BR.po', 'msgid ""\nmsgstr ""\n');
  git('add', '.');
  assert.doesNotMatch(guard().stderr, BLOCKED);

  write('packages/lib/translations/pt-BR/web.po', 'msgid ""\nmsgstr ""\n');
  git('add', '.');
  const blocked = guard();
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, BLOCKED);
  assert.match(blocked.stderr, /packages\/lib\/translations\/pt-BR\/web\.po/);

  assert.doesNotMatch(guard({ REVALLE_ALLOW_UPSTREAM_PO: '1' }).stderr, BLOCKED);

  writeFileSync(join(repo, '.git/MERGE_HEAD'), `${git('rev-parse', 'HEAD').stdout.trim()}\n`);
  assert.doesNotMatch(guard().stderr, BLOCKED);
});
