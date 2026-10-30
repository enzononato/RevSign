// Fase 6, Task 1: perfil Financeiro (tabela própria, sem mexer no `Role` do upstream), tela Admin → Financeiro e
// visibilidade das notas fiscais. Confere:
//   - o admin marca e desmarca um usuário (`revalle.finance.adminSetMember`), a lista mostra a marca e
//     `revalle.finance.me` muda na hora;
//   - quem não é admin recebe 403 nas rotas de admin, e nada muda;
//   - um membro do Financeiro vê na página "Notas fiscais" (`revalle.invoice.find`) e na planilha uma NF em que não
//     está envolvido (menos a excluída pelo remetente); desmarcado, deixa de ver na hora;
//   - a migração `20261101100000_revalle_finance` marcou como `LEGACY` as NFs que já existiam.
//
// Sessões: REVSIGN_ADMIN_* (rsadmin, ADMIN, fica marcado como Financeiro: é o membro dos testes da Fase 6) e
// REVSIGN_USER_* (admin@hml.local, dono do REVSIGN_API_TOKEN, usuário comum e fora do Financeiro). O membro sem
// envolvimento na NF é uma conta nova a cada execução (cadastro + confirmação pelo Mailpit). Ver revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { PDFDocument, rgb, StandardFonts } from '@cantoo/pdf-lib';

import {
  api,
  assertNoPaidGeminiCalls,
  BASE_URL,
  createEnvelope,
  db,
  fetchIdempotent,
  signIn,
  trpcAs,
} from './helpers.mjs';

// Para antes de criar qualquer NF se o app puder chamar o Gemini de verdade (pago). Ver helpers.mjs.
assertNoPaidGeminiCalls();

const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };

const MIGRATION = '20261101100000_revalle_finance';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = `Fin-${RUN}-Senha!9`;
const MAILPIT = 'http://localhost:8025/api/v1';
const origin = new URL(BASE_URL).origin;

const ACCOUNTS_CSV = [
  'numero;nome;descricao;tipo',
  '2.1.03;Fornecedores;Compra de mercadorias e insumos a prazo;pagar',
  '3.1.01;Serviços de terceiros;Serviços tomados de pessoa jurídica;pagar',
  '1.1.01;Caixa;Dinheiro em caixa;receber',
].join('\n');

const tmp = mkdtempSync(path.join(tmpdir(), 'revsign-financeiro-'));

let userCookie;
let adminCookie;
let userId;
let adminId;
// Conta nova, sem papel de admin e sem envolvimento nas NFs do teste.
let outsider;

const data = (res) => res.body?.result?.data?.json;
const finance = (cookie, kind, name, input) => trpcAs(cookie, kind, `revalle.finance.${name}`, input);
const setMember = (cookie, id, member) => finance(cookie, 'mutation', 'adminSetMember', { userId: id, member });
const memberRows = (id) => db(`select count(*) from "RevalleFinanceMember" where "userId" = ${id}`);

const isFinance = async (cookie) => {
  const res = await finance(cookie, 'query', 'me', undefined);

  assert.equal(res.status, 200, res.text);

  return data(res).isFinance;
};

const listUsers = async (query) => {
  const res = await finance(adminCookie, 'query', 'adminListUsers', query === undefined ? {} : { query });

  assert.equal(res.status, 200, res.text);

  return data(res).users;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mailpit = (route) => fetchIdempotent(`${MAILPIT}${route}`, {}, (res) => res.json());

const waitMail = async (to, timeoutMs = 40_000) => {
  const deadline = Date.now() + timeoutMs;

  do {
    const [message] = (await mailpit(`/search?query=${encodeURIComponent(`to:${to}`)}`)).messages ?? [];

    if (message) {
      return message;
    }

    await sleep(500);
  } while (Date.now() < deadline);

  return undefined;
};

// Conta nova com e-mail da empresa (o cadastro só aceita os domínios da empresa), confirmada pelo link do Mailpit.
const newAccount = async (label) => {
  const email = `f6-${label}-${RUN}@revalle.com.br`;
  const created = await fetch(`${BASE_URL}/api/auth/email-password/signup`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'X-Forwarded-For': `203.0.113.${Math.floor(Math.random() * 250) + 1}`,
    },
    body: JSON.stringify({ name: `Financeiro F6 ${label}`, email, password: PASSWORD }),
  });

  assert.ok(created.ok, `cadastro de ${label} falhou (${created.status}): ${await created.text()}`);

  const message = await waitMail(email);

  assert.ok(message, `e-mail de confirmação de ${label} não chegou`);

  const html = (await mailpit(`/message/${message.ID}`)).HTML ?? '';
  const token = html.match(/\/verify-email\/([A-Za-z0-9_-]+)/)?.[1];

  assert.ok(token, `link de confirmação ausente para ${label}`);

  const verified = await fetch(`${BASE_URL}/api/auth/email-password/verify-email`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });

  assert.equal(verified.status, 200, await verified.text());

  return {
    email,
    id: Number(db(`select id from "User" where email = '${email}'`)),
    cookie: await signIn(email, PASSWORD),
  };
};

const textPdf = async (lines) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  let y = 800;

  for (const line of lines) {
    page.drawText(line, { x: 40, y, size: 10, font, color: rgb(0, 0, 0) });
    y -= 16;
  }

  return Buffer.from(await doc.save());
};

// DANFE fictício; `variant` muda o arquivo (outra SHA-256, sem cache da sugestão).
const danfe = async (variant) => {
  const file = path.join(tmp, `danfe-${variant}.pdf`);

  writeFileSync(
    file,
    await textPdf([
      'DANFE - Documento Auxiliar da Nota Fiscal Eletrônica',
      'Nº 000.012.345   Série 001',
      'Chave de Acesso',
      '2924 1012 3456 7800 0195 5500 1000 0123 4511 2345 6784',
      'Natureza da Operação: Venda de mercadoria adquirida de terceiros',
      'Emitente: Distribuidora Fictícia de Ferragens Ltda   CNPJ 12.345.678/0001-95',
      `Referência do teste: financeiro ${variant} ${RUN}`,
      'Valor Total da Nota: R$ 150,00',
    ]),
  );

  return file;
};

// NF do usuário comum (dono do REVSIGN_API_TOKEN), com conta escolhida e enviada a um destinatário qualquer.
const sentInvoice = async (variant) => {
  const created = await createEnvelope({
    recipients: [{ email: `f6-dest-${RUN}-${Math.random().toString(36).slice(2, 7)}@revalle.com.br` }],
    pdf: await danfe(variant),
    title: `[TESTE NF] financeiro ${variant} ${RUN}`,
  });

  assert.equal(created.status, 200, created.text);

  const chosen = await trpcAs(userCookie, 'mutation', 'revalle.invoice.setChoice', {
    envelopeId: created.id,
    choice: { code: '2.1.03' },
  });

  assert.equal(chosen.status, 200, chosen.text);

  const sent = await api('POST', '/envelope/distribute', { envelopeId: created.id });

  assert.equal(sent.status, 200, sent.text);

  return created.id;
};

const findIds = async (cookie) => {
  const res = await trpcAs(cookie, 'query', 'revalle.invoice.find', { perPage: 100 });

  assert.equal(res.status, 200, res.text);

  return data(res).data;
};

const csv = (cookie) =>
  fetchIdempotent(
    `${BASE_URL}/notas-fiscais/csv`,
    { headers: { Cookie: cookie }, redirect: 'manual' },
    async (res) => ({
      status: res.status,
      text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer()),
    }),
  );

const sessionTest = (name, fn) =>
  test(name, async (t) => {
    if (!userCookie || !adminCookie) {
      t.skip('credenciais de sessão não informadas');

      return;
    }

    await fn(t);
  });

before(async () => {
  if (!user.email || !user.password || !admin.email || !admin.password) {
    return;
  }

  userCookie = await signIn(user.email, user.password);
  adminCookie = await signIn(admin.email, admin.password);
  userId = Number(db(`select id from "User" where email = '${user.email}'`));
  adminId = Number(db(`select id from "User" where email = '${admin.email}'`));

  // O membro do Financeiro dos testes da Fase 6 é o rsadmin, marcado pela rota de admin (fica marcado).
  const marked = await setMember(adminCookie, adminId, true);

  assert.equal(marked.status, 200, marked.text);

  // O usuário comum nunca é do Financeiro (sobra de execução interrompida sai aqui).
  db(`delete from "RevalleFinanceMember" where "userId" = ${userId}`);

  const imported = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminImportAccounts', { csv: ACCOUNTS_CSV });

  assert.equal(imported.status, 200, imported.text);
  db(`delete from "RateLimit" where action like 'revalle.invoice%'`);

  outsider = await newAccount('membro');
});

sessionTest('o admin marca e desmarca um usuário; a lista e me() mostram a mudança na hora', async () => {
  assert.equal(await isFinance(adminCookie), true);
  assert.equal(await isFinance(outsider.cookie), false);

  const [before] = await listUsers(outsider.email);

  assert.deepEqual(before, { id: outsider.id, name: `Financeiro F6 membro`, email: outsider.email, isFinance: false });

  const marked = await setMember(adminCookie, outsider.id, true);

  assert.equal(marked.status, 200, marked.text);
  assert.equal(await isFinance(outsider.cookie), true);
  assert.equal(db(`select "addedById" from "RevalleFinanceMember" where "userId" = ${outsider.id}`), String(adminId));
  assert.equal((await listUsers(outsider.email))[0].isFinance, true);

  // Marcar de novo não duplica nem dá erro.
  assert.equal((await setMember(adminCookie, outsider.id, true)).status, 200);
  assert.equal(memberRows(outsider.id), '1');

  // A busca é por nome ou e-mail, sem diferenciar maiúsculas.
  assert.ok((await listUsers(`FINANCEIRO F6 MEMBRO`)).some((row) => row.id === outsider.id));

  // Sem busca, quem é do Financeiro aparece primeiro.
  const all = await listUsers();
  const firstOther = all.findIndex((row) => !row.isFinance);

  assert.ok(all.some((row) => row.id === adminId && row.isFinance));
  assert.ok(firstOther === -1 || all.slice(firstOther).every((row) => !row.isFinance), 'membros primeiro');

  const unmarked = await setMember(adminCookie, outsider.id, false);

  assert.equal(unmarked.status, 200, unmarked.text);
  assert.equal(await isFinance(outsider.cookie), false);
  assert.equal(memberRows(outsider.id), '0');
  assert.equal((await listUsers(outsider.email))[0].isFinance, false);

  // Desmarcar quem não é membro também não dá erro.
  assert.equal((await setMember(adminCookie, outsider.id, false)).status, 200);

  // Usuário que não existe: 404.
  assert.equal((await setMember(adminCookie, 2_000_000_000, true)).status, 404);
});

sessionTest('quem não é admin recebe 403 nas rotas de admin, e nada muda; sem sessão, 401', async () => {
  for (const cookie of [userCookie, outsider.cookie]) {
    const list = await finance(cookie, 'query', 'adminListUsers', {});

    assert.equal(list.status, 403, list.text);

    const set = await setMember(cookie, userId, true);

    assert.equal(set.status, 403, set.text);
  }

  assert.equal(memberRows(userId), '0');
  assert.equal(await isFinance(userCookie), false);

  assert.equal((await finance('', 'query', 'me', undefined)).status, 401);
  assert.equal((await finance('', 'query', 'adminListUsers', {})).status, 401);
});

sessionTest(
  'membro do Financeiro vê a NF em que não está envolvido (menos a excluída); desmarcado, deixa de ver',
  async () => {
    const visible = await sentInvoice('visivel');
    const deleted = await sentInvoice('excluida');

    // O upstream só faz exclusão suave de documento concluído (pendente é apagado de vez), e concluir exige o portão
    // e, a partir da Task 3, a aprovação do Financeiro. Aqui grava direto o estado que a exclusão deixa; a exclusão de
    // verdade pela API está no aceite da Fase 5.
    db(`update "Envelope" set "deletedAt" = now() where id = '${deleted}'`);

    // Fora do Financeiro: nada.
    assert.ok(!(await findIds(outsider.cookie)).some((row) => row.id === visible));

    assert.equal((await setMember(adminCookie, outsider.id, true)).status, 200);

    const rows = await findIds(outsider.cookie);
    const row = rows.find((item) => item.id === visible);

    assert.ok(row, 'membro do Financeiro não viu a NF');
    assert.equal(row.account?.code, '2.1.03');
    assert.equal(row.deleted, false);
    assert.ok(!rows.some((item) => item.id === deleted), 'membro do Financeiro viu a NF excluída pelo remetente');

    // A planilha segue a mesma regra.
    const sheet = await csv(outsider.cookie);

    assert.equal(sheet.status, 200, sheet.text.slice(0, 200));
    assert.ok(sheet.text.includes(visible), 'a planilha do membro não tem a NF');
    assert.ok(!sheet.text.includes(deleted), 'a planilha do membro tem a NF excluída');

    // O admin continua vendo as duas (a excluída marcada).
    const adminRows = await findIds(adminCookie);

    assert.ok(adminRows.some((item) => item.id === visible));
    assert.equal(adminRows.find((item) => item.id === deleted)?.deleted, true);

    // Desmarcado: perde a visão na hora.
    assert.equal((await setMember(adminCookie, outsider.id, false)).status, 200);
    assert.ok(!(await findIds(outsider.cookie)).some((item) => item.id === visible));
    assert.ok(!(await csv(outsider.cookie)).text.includes(visible));

    // NF nova nasce na versão 1.
    assert.equal(db(`select version from "RevalleInvoiceClassification" where "envelopeId" = '${visible}'`), '1');
  },
);

test('a migração marcou como LEGACY as NFs que já existiam', (t) => {
  assert.equal(
    db(`select enum_range(null::"RevalleFinanceStatus")::text`),
    '{AWAITING_ACCOUNT,PENDING_APPROVAL,APPROVED,SUPERSEDED,LEGACY}',
  );

  const startedAt = db(`select started_at from "_prisma_migrations" where migration_name = '${MIGRATION}'`);

  assert.ok(startedAt, 'migração não aplicada');

  const before = `"createdAt" < (select started_at from "_prisma_migrations" where migration_name = '${MIGRATION}')`;
  const existing = Number(
    db(`select count(*) from "RevalleInvoiceClassification" where "isInvoice" = 'YES' and ${before}`),
  );

  if (existing === 0) {
    t.skip('nenhuma NF anterior à migração neste banco');

    return;
  }

  assert.equal(
    db(
      `select count(*) from "RevalleInvoiceClassification" where "isInvoice" = 'YES' and ${before} and "financeStatus" is distinct from 'LEGACY'`,
    ),
    '0',
  );
  // Só as NFs: classificação NO/UNKNOWN fica sem estado do Financeiro.
  assert.equal(
    db(
      `select count(*) from "RevalleInvoiceClassification" where "isInvoice" <> 'YES' and ${before} and "financeStatus" is not null`,
    ),
    '0',
  );
});
