// Fase 5, Task 2: tela de admin "Contas contábeis" (importar CSV com prévia, lista, prompt, e-mail da contabilidade,
// estado da IA). Rotas de admin: REVSIGN_ADMIN_EMAIL / REVSIGN_ADMIN_PASSWORD (papel ADMIN). Recusa ao usuário comum:
// REVSIGN_USER_EMAIL / REVSIGN_USER_PASSWORD. Os testes apagam e recriam a lista de contas da stack local.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { before, test } from 'node:test';

import { db, signIn, trpc, trpcAs } from './helpers.mjs';

const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };
const sessionOpts = (creds) => (creds.email && creds.password ? {} : { skip: 'credenciais de sessão não informadas' });

const HEADER = 'numero;nome;descricao;tipo';
const VALID = [
  '1.1.01;Caixa;Dinheiro em caixa;receber',
  '2.1.03;Fornecedores;Compras a prazo;pagar',
  '9.9.99;Diversos;;',
];

let userCookie;
let adminCookie;

const data = (res) => res.body?.result?.data?.json;
const route = (name) => `revalle.invoice.${name}`;
const asAdmin = (kind, name, input) => trpcAs(adminCookie, kind, route(name), input);
const accountCount = () => Number(db('select count(*) from "RevalleAccountingAccount"'));

// Sem imprimir o valor: só diz se a variável está definida (e não vazia) dentro do container do app.
const containerHasEnv = (name) => {
  try {
    execFileSync('docker', ['exec', 'revsign-hml-documenso-1', 'sh', '-c', `test -n "$${name}"`], { stdio: 'ignore' });

    return true;
  } catch {
    return false;
  }
};

const containerEnv = (name) =>
  execFileSync('docker', ['exec', 'revsign-hml-documenso-1', 'sh', '-c', `printf %s "$${name}"`], {
    encoding: 'utf8',
  });

before(async () => {
  if (user.email && user.password) {
    userCookie = await signIn(user.email, user.password);
  }

  if (admin.email && admin.password) {
    adminCookie = await signIn(admin.email, admin.password);
  }
});

test('prévia: mostra as contas válidas e os erros por linha, sem gravar nada', sessionOpts(admin), async () => {
  const before = accountCount();
  const csv = [HEADER, VALID[0], ';Sem número;;', VALID[1], '3.1;Tipo errado;;talvez', VALID[2]].join('\n');

  const res = await asAdmin('mutation', 'adminPreviewAccounts', { csv });

  assert.equal(res.status, 200, res.text);
  assert.deepEqual(
    data(res).accounts.map((account) => account.code),
    ['1.1.01', '2.1.03', '9.9.99'],
  );
  assert.deepEqual(data(res).errors, [
    { line: 3, message: 'Falta o número da conta' },
    { line: 5, message: 'Tipo inválido: use pagar, receber ou deixe em branco' },
  ]);
  assert.equal(accountCount(), before);
});

test(
  'prévia de arquivo: Windows-1252 é lido; texto com caractere quebrado mostra o erro',
  sessionOpts(admin),
  async () => {
    const latin1 = Buffer.from(`${HEADER}\r\n3.2.01;Manutenção;Peças;pagar\r\n`, 'latin1');

    const file = data(await asAdmin('mutation', 'adminPreviewAccounts', { csvBase64: latin1.toString('base64') }));

    assert.equal(file.encoding, 'windows-1252');
    assert.deepEqual(file.errors, []);
    assert.equal(file.accounts[0].name, 'Manutenção');

    const broken = data(await asAdmin('mutation', 'adminPreviewAccounts', { csv: `${HEADER}\nx;Manuten��o;;\n` }));

    assert.equal(broken.accounts.length, 0);
    assert.match(broken.errors[0].message, /CSV UTF-8/);
  },
);

test(
  'importar: com erro é recusado; válido cria; reimportar sem uma conta a deixa inativa',
  sessionOpts(admin),
  async () => {
    db('delete from "RevalleAccountingAccount"');

    const refused = await asAdmin('mutation', 'adminImportAccounts', {
      csv: [HEADER, VALID[0], ';Sem número;;'].join('\n'),
    });

    assert.equal(refused.status, 400, refused.text);
    assert.equal(accountCount(), 0);

    const first = await asAdmin('mutation', 'adminImportAccounts', { csv: [HEADER, ...VALID].join('\n') });

    assert.equal(first.status, 200, first.text);
    assert.deepEqual(data(first), { created: 3, updated: 0, deactivated: 0 });

    const second = await asAdmin('mutation', 'adminImportAccounts', {
      csv: [HEADER, VALID[0], '2.1.03;Fornecedores nacionais;Compras a prazo;pagar'].join('\n'),
    });

    assert.equal(second.status, 200, second.text);
    assert.deepEqual(data(second), { created: 0, updated: 1, deactivated: 1 });

    const active = data(await asAdmin('query', 'adminFindAccounts', {}));

    assert.deepEqual(
      active.accounts.map((account) => [account.code, account.name, account.active]),
      [
        ['1.1.01', 'Caixa', true],
        ['2.1.03', 'Fornecedores nacionais', true],
      ],
    );

    const search = data(await asAdmin('query', 'adminFindAccounts', { query: 'fornec' }));

    assert.deepEqual(
      search.accounts.map((account) => account.code),
      ['2.1.03'],
    );

    const all = data(await asAdmin('query', 'adminFindAccounts', { query: '9.9.99', includeInactive: true }));

    assert.deepEqual(
      all.accounts.map((account) => [account.code, account.active]),
      [['9.9.99', false]],
    );
    assert.equal(db(`select active from "RevalleAccountingAccount" where code = '9.9.99'`), 'f');

    const empty = await asAdmin('mutation', 'adminImportAccounts', { csv: `${HEADER}\n` });

    assert.equal(empty.status, 400, empty.text);
    assert.equal(db('select count(*) from "RevalleAccountingAccount" where active'), '2');

    const back = data(await asAdmin('mutation', 'adminImportAccounts', { csv: [HEADER, ...VALID].join('\n') }));

    assert.deepEqual(back, { created: 0, updated: 2, deactivated: 0 });
  },
);

test('configurações: prompt e e-mail salvos aparecem; e-mail inválido é recusado', sessionOpts(admin), async () => {
  const prompt = `Prefira contas a pagar. ${Date.now()}`;

  const saved = await asAdmin('mutation', 'adminUpdateSettings', {
    prompt,
    accountingEmail: 'contabil@revalle.com.br',
  });

  assert.equal(saved.status, 200, saved.text);

  const settings = data(await asAdmin('query', 'adminGetSettings', {}));

  assert.equal(settings.prompt, prompt);
  assert.equal(settings.accountingEmail, 'contabil@revalle.com.br');
  assert.equal(settings.updatedBy.email, admin.email);
  assert.ok(settings.updatedAt);

  const invalid = await asAdmin('mutation', 'adminUpdateSettings', { prompt, accountingEmail: 'contabil@' });

  assert.equal(invalid.status, 400, invalid.text);
  assert.equal(data(await asAdmin('query', 'adminGetSettings', {})).accountingEmail, 'contabil@revalle.com.br');

  const cleared = await asAdmin('mutation', 'adminUpdateSettings', { prompt, accountingEmail: '' });

  assert.equal(cleared.status, 200, cleared.text);
  assert.equal(data(await asAdmin('query', 'adminGetSettings', {})).accountingEmail, null);
});

test('estado da IA segue as variáveis do app (sem GEMINI_API_KEY = NO_KEY)', sessionOpts(admin), async () => {
  const isDisabled = containerEnv('NEXT_PRIVATE_REVALLE_INVOICE_AI').trim().toLowerCase() === 'disabled';
  const hasKey = containerHasEnv('GEMINI_API_KEY');
  const expected = isDisabled ? 'DISABLED' : hasKey ? 'CONFIGURED' : 'NO_KEY';

  const settings = data(await asAdmin('query', 'adminGetSettings', {}));

  assert.equal(settings.aiStatus, expected);
  assert.equal(settings.model, containerEnv('NEXT_PRIVATE_REVALLE_GEMINI_MODEL') || 'gemini-3.6-flash');
});

test('usuário comum e visitante não usam as rotas de admin', sessionOpts(user), async () => {
  const before = accountCount();
  const calls = [
    ['mutation', 'adminPreviewAccounts', { csv: `${HEADER}\n${VALID[0]}` }],
    ['mutation', 'adminImportAccounts', { csv: `${HEADER}\n${VALID[0]}` }],
    ['query', 'adminFindAccounts', {}],
    ['query', 'adminGetSettings', {}],
    ['mutation', 'adminUpdateSettings', { prompt: 'invasão', accountingEmail: '' }],
  ];

  for (const [kind, name, input] of calls) {
    const res = await trpcAs(userCookie, kind, route(name), input);

    assert.ok(res.status === 401 || res.status === 403, `${name}: ${res.status} ${res.text}`);
    assert.ok(!res.text.includes('Caixa'), name);
  }

  const anonymous = await trpc(route('adminImportAccounts'), { csv: `${HEADER}\n${VALID[0]}` });

  assert.ok(anonymous.status === 401 || anonymous.status === 403, anonymous.text);
  assert.equal(accountCount(), before);
  assert.notEqual(db(`select coalesce(prompt, '') from "RevalleAccountingSettings" where id = 1`), 'invasão');
});
