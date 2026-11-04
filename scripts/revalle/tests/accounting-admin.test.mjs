// Fase 7, Task 5: perfil Contabilidade (tabela própria `RevalleAccountingMember`, marcada pelo admin em Admin → Perfis,
// igual ao Financeiro e sem mexer no `Role` do upstream). Confere:
//   - o admin marca e desmarca (`revalle.accounting.adminSetMember`) e `revalle.accounting.me` muda na hora; a lista de
//     `revalle.finance.adminListUsers` devolve os dois perfis por pessoa e uma pessoa pode ter os dois;
//   - usuário comum (e quem só é da Contabilidade) recebe 403 ao marcar; sem sessão, 401; nada muda;
//   - quem é da Contabilidade vê na lista, na página, no PDF e na planilha uma NF em que não está envolvido (como o
//     Financeiro); o rascunho de outra pessoa não aparece; desmarcado, perde tudo na hora;
//   - a Contabilidade NÃO ganha as ações do Financeiro (aprovar, trocar a conta): 403;
//   - quem é da Contabilidade continua enviando e assinando como qualquer colaborador;
//   - `/admin/revalle-financeiro` leva a `/admin/revalle-perfis`.
//
// Sessões: REVSIGN_ADMIN_* (rsadmin, ADMIN, também do Financeiro nos testes da Fase 6) e REVSIGN_USER_* (admin@hml.local,
// dono do REVSIGN_API_TOKEN, usuário comum). A pessoa sem envolvimento nas NFs é uma conta nova a cada execução
// (cadastro + confirmação pelo Mailpit). Ver revalle/docs/testes.md.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { PDFDocument, rgb, StandardFonts } from '@cantoo/pdf-lib';

import {
  assertNoPaidGeminiCalls,
  BASE_URL,
  chooseInvoice,
  completeWithCode,
  createEnvelope,
  db,
  distribute,
  fetchIdempotent,
  retryCreateOnStaleSocket,
  signIn,
  signupColaborador,
  trpc,
  trpcAs,
} from './helpers.mjs';

// Para antes de criar qualquer NF se o app puder chamar o Gemini de verdade (pago). Ver helpers.mjs.
assertNoPaidGeminiCalls();

const user = { email: process.env.REVSIGN_USER_EMAIL, password: process.env.REVSIGN_USER_PASSWORD };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = `Cont-${RUN}-Senha!9`;
const MAILPIT = 'http://localhost:8025/api/v1';
const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const origin = new URL(BASE_URL).origin;

const ACCOUNTS_CSV = [
  'numero;nome;descricao;tipo',
  '2.1.03;Fornecedores;Compra de mercadorias e insumos a prazo;pagar',
  '3.1.01;Serviços de terceiros;Serviços tomados de pessoa jurídica;pagar',
  '1.1.01;Caixa;Dinheiro em caixa;receber',
].join('\n');

const tmp = mkdtempSync(path.join(tmpdir(), 'revsign-contabilidade-'));

let userCookie;
let adminCookie;
let userId;
let adminId;
// Conta nova, sem papel de admin e sem envolvimento nas NFs do teste.
let outsider;

const data = (res) => res.body?.result?.data?.json;
const accounting = (cookie, kind, name, input) => trpcAs(cookie, kind, `revalle.accounting.${name}`, input);
const finance = (cookie, kind, name, input) => trpcAs(cookie, kind, `revalle.finance.${name}`, input);
const setAccounting = (cookie, id, isMember) =>
  accounting(cookie, 'mutation', 'adminSetMember', { userId: id, isMember });
const setFinance = (cookie, id, member) => finance(cookie, 'mutation', 'adminSetMember', { userId: id, member });
const accountingRows = (id) => db(`select count(*) from "RevalleAccountingMember" where "userId" = ${id}`);
const financeRows = (id) => db(`select count(*) from "RevalleFinanceMember" where "userId" = ${id}`);

const isAccountingMe = async (cookie) => {
  const res = await accounting(cookie, 'query', 'me', undefined);

  assert.equal(res.status, 200, res.text);

  return data(res);
};

const isFinanceMe = async (cookie) => {
  const res = await finance(cookie, 'query', 'me', undefined);

  assert.equal(res.status, 200, res.text);

  return data(res).isFinance;
};

const listProfiles = async (query) => {
  const res = await finance(adminCookie, 'query', 'adminListUsers', query === undefined ? {} : { query });

  assert.equal(res.status, 200, res.text);

  return data(res);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mailpit = (route) => fetchIdempotent(`${MAILPIT}${route}`, {}, (res) => res.json());

const waitMail = async (to, timeoutMs = 40_000) => {
  const deadline = performance.now() + timeoutMs;

  do {
    const [message] = (await mailpit(`/search?query=${encodeURIComponent(`to:${to}`)}`)).messages ?? [];

    if (message) {
      return message;
    }

    await sleep(500);
  } while (performance.now() < deadline);

  return undefined;
};

// Conta nova com e-mail da empresa (o cadastro só aceita os domínios da empresa), confirmada pelo link do Mailpit.
const newAccount = async (label) => {
  const email = `f7-${label}-${RUN}@revalle.com.br`;
  const created = await signupColaborador({ name: `Contabilidade F7 ${label}`, email, password: PASSWORD });

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

// DANFE fictício; `variant` muda o arquivo (outra SHA-256, sem cache da sugestão).
const danfe = async (variant) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  let y = 800;

  for (const line of [
    'DANFE - Documento Auxiliar da Nota Fiscal Eletrônica',
    'Nº 000.012.345   Série 001',
    'Chave de Acesso',
    '2924 1012 3456 7800 0195 5500 1000 0123 4511 2345 6784',
    'Natureza da Operação: Venda de mercadoria adquirida de terceiros',
    'Emitente: Distribuidora Fictícia de Ferragens Ltda   CNPJ 12.345.678/0001-95',
    `Referência do teste: contabilidade ${variant} ${RUN}`,
    'Valor Total da Nota: R$ 150,00',
  ]) {
    page.drawText(line, { x: 40, y, size: 10, font, color: rgb(0, 0, 0) });
    y -= 16;
  }

  const file = path.join(tmp, `danfe-${variant}.pdf`);

  writeFileSync(file, Buffer.from(await doc.save()));

  return file;
};

// NF do usuário comum (dono do REVSIGN_API_TOKEN) criada com um destinatário qualquer. `send: false` deixa o rascunho.
const newInvoice = async (variant, { send = true, recipient } = {}) => {
  const title = `[TESTE NF] contabilidade ${variant} ${RUN}`;
  const created = await retryCreateOnStaleSocket(async () =>
    createEnvelope({
      recipients: [{ email: recipient ?? `f7-dest-${variant}-${RUN}@revalle.com.br` }],
      pdf: await danfe(variant),
      title,
    }),
  );

  assert.equal(created.status, 200, created.text);

  const chosen = await chooseInvoice({ cookie: userCookie, envelopeId: created.id });

  assert.equal(chosen.status, 200, chosen.text);

  const recipients = send ? await distribute(created.id) : [];

  return {
    id: created.id,
    title,
    documentId: Number.parseInt(created.envelope.secondaryId.split('_')[1], 10),
    item: created.envelope.envelopeItems[0].id,
    fields: created.envelope.fields,
    recipients,
  };
};

const findRows = async (cookie) => {
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

const invoicePage = (cookie, envelopeId, suffix = '') =>
  fetchIdempotent(
    `${BASE_URL}/notas-fiscais/${envelopeId}${suffix}`,
    { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' },
    async (res) => ({
      status: res.status,
      type: res.headers.get('content-type') ?? '',
      bytes: Buffer.from(await res.arrayBuffer()),
    }),
  );

const gate = async (token) => {
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
  db('delete from "RateLimit"');
  await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' });
  await trpc('revalle.gate.verifyIdentity', { token, ...MARIA });
  await trpc('revalle.gate.confirmIdentity', { token, isMe: true });
};

// Portão (termo, CPF + data de nascimento da Maria fictícia, "sou eu"), assinatura e conclusão com o código.
const sign = async (doc, index) => {
  const recipient = doc.recipients[index];
  const field = doc.fields.find((f) => f.recipientId === recipient.id && f.type === 'SIGNATURE');

  await gate(recipient.token);

  const signed = await trpc('envelope.field.sign', {
    token: recipient.token,
    fieldId: field.id,
    fieldValue: { type: 'SIGNATURE', value: 'Teste Digitado' },
  });

  assert.equal(signed.status, 200, signed.text);

  const completion = await completeWithCode({
    token: recipient.token,
    documentId: doc.documentId,
    email: recipient.email,
  });

  assert.ok(completion.ok, completion.text);
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
};

const sessionTest = (name, fn) =>
  test(name, async (t) => {
    if (!userCookie || !adminCookie) {
      t.skip('credenciais de sessão não informadas');

      return;
    }

    await fn(t);
  });

const cleanMarks = () => {
  const ids = [userId, outsider?.id].filter(Boolean).join(', ');

  if (ids) {
    db(`delete from "RevalleAccountingMember" where "userId" in (${ids})`);
  }
};

before(async () => {
  if (!user.email || !user.password || !admin.email || !admin.password) {
    return;
  }

  userCookie = await signIn(user.email, user.password);
  adminCookie = await signIn(admin.email, admin.password);
  userId = Number(db(`select id from "User" where email = '${user.email}'`));
  adminId = Number(db(`select id from "User" where email = '${admin.email}'`));

  // O membro do Financeiro dos testes da Fase 6 é o rsadmin (fica marcado); o usuário comum nunca é do Financeiro nem
  // da Contabilidade (sobra de execução interrompida sai aqui).
  const marked = await setFinance(adminCookie, adminId, true);

  assert.equal(marked.status, 200, marked.text);
  db(`delete from "RevalleFinanceMember" where "userId" = ${userId}`);
  db(`delete from "RevalleAccountingMember" where "userId" = ${userId}`);

  const imported = await trpcAs(adminCookie, 'mutation', 'revalle.invoice.adminImportAccounts', { csv: ACCOUNTS_CSV });

  assert.equal(imported.status, 200, imported.text);
  db(`delete from "RateLimit" where action like 'revalle.invoice%'`);

  outsider = await newAccount('contab');
});

after(() => {
  if (userId) {
    cleanMarks();
  }
});

sessionTest('quem não é admin recebe 403 ao marcar a Contabilidade; sem sessão, 401; nada muda', async () => {
  for (const cookie of [userCookie, outsider.cookie]) {
    const set = await setAccounting(cookie, userId, true);

    assert.equal(set.status, 403, set.text);
  }

  assert.equal(accountingRows(userId), '0');
  assert.deepEqual(await isAccountingMe(userCookie), { isMember: false });

  // Ser da Contabilidade não dá poder de admin: quem foi marcado também não marca os outros.
  assert.equal((await setAccounting(adminCookie, outsider.id, true)).status, 200);

  const sneaky = await setAccounting(outsider.cookie, userId, true);

  assert.equal(sneaky.status, 403, sneaky.text);
  assert.equal(accountingRows(userId), '0');
  assert.equal((await setAccounting(adminCookie, outsider.id, false)).status, 200);

  assert.equal((await accounting('', 'query', 'me', undefined)).status, 401);
  assert.equal((await setAccounting('', userId, true)).status, 401);
});

sessionTest(
  'o admin marca e desmarca; me() e a lista mostram na hora, e uma pessoa pode ter os dois perfis',
  async () => {
    assert.deepEqual(await isAccountingMe(outsider.cookie), { isMember: false });

    const initial = await listProfiles(outsider.email);

    assert.deepEqual(initial.users, [
      {
        id: outsider.id,
        name: 'Contabilidade F7 contab',
        email: outsider.email,
        isFinanceMember: false,
        isAccountingMember: false,
      },
    ]);

    const countBefore = initial.accountingMemberCount;
    const marked = await setAccounting(adminCookie, outsider.id, true);

    assert.equal(marked.status, 200, marked.text);
    assert.deepEqual(await isAccountingMe(outsider.cookie), { isMember: true });
    assert.equal(
      db(`select "addedById" from "RevalleAccountingMember" where "userId" = ${outsider.id}`),
      String(adminId),
    );

    const afterMark = await listProfiles(outsider.email);

    assert.equal(afterMark.users[0].isAccountingMember, true);
    assert.equal(afterMark.users[0].isFinanceMember, false, 'marcar a Contabilidade marcou o Financeiro');
    assert.equal(await isFinanceMe(outsider.cookie), false);
    assert.equal(afterMark.accountingMemberCount, countBefore + 1);
    assert.equal(
      afterMark.accountingMemberCount,
      Number(
        db(
          `select count(*) from "RevalleAccountingMember" m join "User" u on u.id = m."userId" where u."disabled" = false`,
        ),
      ),
    );

    // Marcar de novo não duplica nem dá erro.
    assert.equal((await setAccounting(adminCookie, outsider.id, true)).status, 200);
    assert.equal(accountingRows(outsider.id), '1');

    // A mesma pessoa nos dois perfis; tirar um não tira o outro.
    assert.equal((await setFinance(adminCookie, outsider.id, true)).status, 200);

    const both = (await listProfiles(outsider.email)).users[0];

    assert.equal(both.isFinanceMember && both.isAccountingMember, true);

    assert.equal((await setAccounting(adminCookie, outsider.id, false)).status, 200);
    assert.deepEqual(await isAccountingMe(outsider.cookie), { isMember: false });
    assert.equal(await isFinanceMe(outsider.cookie), true, 'desmarcar a Contabilidade tirou o Financeiro');

    const financeOnly = (await listProfiles(outsider.email)).users[0];

    assert.equal(financeOnly.isFinanceMember, true);
    assert.equal(financeOnly.isAccountingMember, false);

    assert.equal((await setFinance(adminCookie, outsider.id, false)).status, 200);
    assert.equal(financeRows(outsider.id), '0');
    assert.equal(accountingRows(outsider.id), '0');

    // Quem é de qualquer um dos perfis aparece antes dos outros, sem busca.
    assert.equal((await setAccounting(adminCookie, outsider.id, true)).status, 200);

    const all = (await listProfiles()).users;
    const firstOther = all.findIndex((row) => !row.isFinanceMember && !row.isAccountingMember);

    assert.ok(all.some((row) => row.id === outsider.id && row.isAccountingMember));
    assert.ok(all.some((row) => row.id === adminId && row.isFinanceMember));
    assert.ok(
      firstOther === -1 || all.slice(firstOther).every((row) => !row.isFinanceMember && !row.isAccountingMember),
      'quem tem perfil vem primeiro',
    );

    assert.equal((await setAccounting(adminCookie, outsider.id, false)).status, 200);

    // Desmarcar quem não é membro não dá erro; usuário que não existe: 404; `isMember` fora do formato: 400.
    assert.equal((await setAccounting(adminCookie, outsider.id, false)).status, 200);
    assert.equal((await setAccounting(adminCookie, 2_000_000_000, true)).status, 404);
    assert.equal((await accounting(adminCookie, 'mutation', 'adminSetMember', { userId: outsider.id })).status, 400);
    assert.equal(accountingRows(outsider.id), '0');
  },
);

sessionTest(
  'quem é da Contabilidade vê a NF em que não está envolvido (lista, página, PDF, planilha), sem o rascunho dos outros; desmarcado, perde',
  async () => {
    const visible = await newInvoice('visivel');
    const draft = await newInvoice('rascunho', { send: false });

    // Fora da Contabilidade: nada, em nenhum caminho.
    assert.ok(!(await findRows(outsider.cookie)).some((row) => row.id === visible.id));
    assert.equal((await invoicePage(outsider.cookie, visible.id)).status, 404);
    assert.equal((await invoicePage(outsider.cookie, visible.id, `/pdf/${visible.item}`)).status, 404);
    assert.ok(!(await csv(outsider.cookie)).text.includes(visible.id));

    assert.equal((await setAccounting(adminCookie, outsider.id, true)).status, 200);

    const rows = await findRows(outsider.cookie);
    const row = rows.find((item) => item.id === visible.id);

    assert.ok(row, 'a Contabilidade não viu a NF na lista');
    assert.equal(row.account?.code, '2.1.03');
    assert.equal(row.link, `/notas-fiscais/${visible.id}`, 'o link da Contabilidade tem de ser a página da NF');
    assert.ok(!rows.some((item) => item.id === draft.id), 'a Contabilidade viu o rascunho de outra pessoa na lista');

    const page = await invoicePage(outsider.cookie, visible.id);

    assert.equal(page.status, 200);
    assert.ok(page.bytes.toString('utf8').includes(visible.title), 'a página da NF não traz o título');

    const pdf = await invoicePage(outsider.cookie, visible.id, `/pdf/${visible.item}`);

    assert.equal(pdf.status, 200);
    assert.equal(pdf.type, 'application/pdf');
    assert.equal(pdf.bytes.subarray(0, 5).toString('latin1'), '%PDF-');

    const sheet = await csv(outsider.cookie);

    assert.equal(sheet.status, 200, sheet.text.slice(0, 200));
    assert.ok(sheet.text.includes(`/notas-fiscais/${visible.id}`), 'a planilha da Contabilidade não tem a NF');
    assert.ok(!sheet.text.includes(draft.id), 'a planilha da Contabilidade tem o rascunho de outra pessoa');

    // O rascunho comum de outra pessoa também não abre pelo endereço (página e PDF), como não aparece na lista. Os
    // controles mostram que o 404 é do acesso, e não de o rascunho não ser uma NF: o dono e o admin abrem.
    const isDraftHidden = async () => {
      assert.equal(
        (await invoicePage(outsider.cookie, draft.id)).status,
        404,
        'a página do rascunho de outra pessoa abriu',
      );
      assert.equal(
        (await invoicePage(outsider.cookie, draft.id, `/pdf/${draft.item}`)).status,
        404,
        'o PDF do rascunho de outra pessoa abriu',
      );
    };

    await isDraftHidden();
    assert.equal((await invoicePage(userCookie, draft.id)).status, 200);
    assert.equal((await invoicePage(adminCookie, draft.id)).status, 200);

    // Ver não é agir: as ações do Financeiro continuam só do Financeiro.
    const approve = await finance(outsider.cookie, 'mutation', 'approve', { envelopeId: visible.id });
    const change = await finance(outsider.cookie, 'mutation', 'changeAccount', {
      envelopeId: visible.id,
      code: '3.1.01',
      reason: 'Troca pedida pela Contabilidade, que não pode trocar a conta.',
    });
    const card = await finance(outsider.cookie, 'query', 'get', { envelopeId: visible.id });

    for (const res of [approve, change, card]) {
      assert.equal(res.status, 403, res.text);
    }

    assert.equal(
      db(`select "financeStatus" from "RevalleInvoiceClassification" where "envelopeId" = '${visible.id}'`),
      'PENDING_APPROVAL',
    );

    // Desmarcada, perde a visão na hora.
    assert.equal((await setAccounting(adminCookie, outsider.id, false)).status, 200);
    assert.ok(!(await findRows(outsider.cookie)).some((item) => item.id === visible.id));
    assert.equal((await invoicePage(outsider.cookie, visible.id)).status, 404);
    assert.equal((await invoicePage(outsider.cookie, visible.id, `/pdf/${visible.item}`)).status, 404);
    assert.ok(!(await csv(outsider.cookie)).text.includes(visible.id));

    // Só com o Financeiro, a leitura é a mesma: vê a NF enviada e não abre o rascunho comum de outra pessoa.
    assert.equal((await setFinance(adminCookie, outsider.id, true)).status, 200);

    try {
      assert.equal((await invoicePage(outsider.cookie, visible.id)).status, 200);
      await isDraftHidden();
    } finally {
      assert.equal((await setFinance(adminCookie, outsider.id, false)).status, 200);
    }

    // O admin continua vendo as duas, e o dono, a dele.
    assert.ok((await findRows(adminCookie)).some((item) => item.id === visible.id));
    assert.ok((await findRows(userCookie)).some((item) => item.id === visible.id));
  },
);

sessionTest('quem é da Contabilidade continua enviando e assinando como qualquer colaborador', async () => {
  // Os dois marcados: quem envia (dono do REVSIGN_API_TOKEN) e quem assina.
  assert.equal((await setAccounting(adminCookie, userId, true)).status, 200);
  assert.equal((await setAccounting(adminCookie, outsider.id, true)).status, 200);

  try {
    const doc = await newInvoice('envio-assinatura', { recipient: outsider.email });

    assert.equal(
      db(`select status from "Envelope" where id = '${doc.id}'`),
      'PENDING',
      'o envio da pessoa da Contabilidade não saiu',
    );
    assert.equal(
      db(`select "financeStatus" from "RevalleInvoiceClassification" where "envelopeId" = '${doc.id}'`),
      'PENDING_APPROVAL',
    );
    assert.equal(doc.recipients.length, 1);

    await sign(doc, 0);

    assert.equal(
      db(`select "signingStatus" from "Recipient" where id = ${doc.recipients[0].id}`),
      'SIGNED',
      'a pessoa da Contabilidade não conseguiu assinar',
    );
    // Assinou, mas a NF espera a aprovação do Financeiro (a Contabilidade não segura nem libera a conclusão).
    assert.equal(db(`select status from "Envelope" where id = '${doc.id}'`), 'PENDING');
    assert.equal(
      db(`select "financeStatus" from "RevalleInvoiceClassification" where "envelopeId" = '${doc.id}'`),
      'PENDING_APPROVAL',
    );

    // Quem enviou e quem assinou veem a NF (cada um pelo próprio caminho).
    assert.ok((await findRows(userCookie)).some((item) => item.id === doc.id));
    assert.ok((await findRows(outsider.cookie)).some((item) => item.id === doc.id));
  } finally {
    cleanMarks();
  }
});

sessionTest('/admin/revalle-financeiro leva a /admin/revalle-perfis (só para o admin)', async () => {
  const get = (cookie, route) =>
    fetchIdempotent(`${BASE_URL}${route}`, { headers: { Cookie: cookie }, redirect: 'manual' }, async (res) => ({
      status: res.status,
      location: res.headers.get('location'),
    }));

  const old = await get(adminCookie, '/admin/revalle-financeiro');

  assert.ok([301, 302, 303, 307, 308].includes(old.status), `status ${old.status}`);
  assert.equal(new URL(old.location, BASE_URL).pathname, '/admin/revalle-perfis');
  assert.equal((await get(adminCookie, '/admin/revalle-perfis')).status, 200);

  // Usuário comum não passa pelo layout do admin, nem pela rota nova nem pela antiga.
  for (const route of ['/admin/revalle-perfis', '/admin/revalle-financeiro']) {
    const res = await get(userCookie, route);

    assert.ok([301, 302, 303, 307, 308].includes(res.status), `${route}: status ${res.status}`);
    assert.equal(new URL(res.location, BASE_URL).pathname, '/');
  }
});
