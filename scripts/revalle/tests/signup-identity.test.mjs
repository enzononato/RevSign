// Cadastro só para colaborador (Task 8, Fase 7): CPF e data de nascimento conferidos na base de colaboradores.
// Pessoas fictícias da base de desenvolvimento: revalle/colaboradores/dev-seed.sql ("Teste Cadastro", João e Maria).
// Precisa da stack com NEXT_PRIVATE_REVALLE_IDENTITY_CHECK=required (padrão). A base fora do ar não entra aqui: ela é
// conferida à mão, parando só o colaboradores-db (revalle/docs/testes.md, "Cadastro com CPF").
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';

import {
  appContainerEnv,
  BASE_URL,
  createEnvelope,
  db,
  distribute,
  latestMail,
  postSignup,
  SIGNUP_COLABORADOR,
  signIn,
  signupColaborador,
  trpc,
} from './helpers.mjs';

const PASSWORD = 'Revalle-Teste-2026!';
const STARTED_AT = new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);

const CADASTRO = SIGNUP_COLABORADOR;
const JOAO = { cpf: '52871936455', birthDate: '20/11/1985', baseEmail: 'com.email@revalle.com.br' };
const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const BEATRIZ = { cpf: '68340192787', birthDate: '09/09/1988' };
// Desligada na base: a situação não bloqueia o cadastro, como na assinatura.
const ANA = { cpf: '74612058380', birthDate: '15/01/1978' };
// CPF válido que não está na base de desenvolvimento.
const FORA_DA_BASE = '52998224725';

const MENSAGEM = {
  REQUIRED: 'Para criar a conta, informe o CPF e a data de nascimento na página de cadastro.',
  INVALID: 'CPF ou data de nascimento não conferem com o cadastro de colaboradores.',
  CONFLICT: 'Este CPF já está vinculado a outro e-mail. Fale com o administrador.',
  LIMITED: 'Muitas tentativas com este CPF. Tente de novo amanhã ou fale com o administrador.',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sql = (value) => `'${String(value).replaceAll("'", "''")}'`;
const newEmail = (label) => `cad-${label}-${SUFFIX}@revalle.com.br`;
const userCount = (email) => Number(db(`select count(*) from "User" where email = ${sql(email)}`));
const linkOf = (email) => db(`select cpf from "RevalleEmailLink" where email = ${sql(email)}`);
const pendingOf = (email) =>
  db(`select s.cpf from "RevalleSignupIdentity" s join "User" u on u.id = s."userId" where u.email = ${sql(email)}`);

const baseSql = (statement) => {
  const result = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      'revsign-hml-colaboradores-db-1',
      'psql',
      '-U',
      'postgres',
      '-d',
      'colaboradores',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      statement,
    ],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
};

const signup = (email, fields = {}) => postSignup({ name: 'Teste Cadastro', email, password: PASSWORD, ...fields });

const withIdentity = (person) => ({ revalleCpf: person.cpf, revalleBirthDate: person.birthDate });

const confirmEmail = async (email) => {
  let token;

  for (let i = 0; i < 40 && !token; i += 1) {
    const mail = await latestMail(email);

    token = mail?.HTML?.match(/\/verify-email\/([A-Za-z0-9_-]+)/)?.[1];

    if (!token) {
      await sleep(500);
    }
  }

  assert.ok(token, `e-mail de confirmação de ${email} não chegou`);

  return fetch(`${BASE_URL}/api/auth/email-password/verify-email`, {
    method: 'POST',
    headers: { Origin: new URL(BASE_URL).origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
};

const TEST_CPFS = [CADASTRO.cpf, JOAO.cpf, MARIA.cpf, BEATRIZ.cpf, ANA.cpf].map(sql).join(',');

const cleanUp = () => {
  db('delete from "RateLimit"');
  db(`delete from "RevalleEmailLink" where cpf in (${TEST_CPFS})`);
  db(`delete from "RevalleSignupIdentity" where cpf in (${TEST_CPFS})`);
};

// A trava por CPF (10 por 24 h) é de todo o arquivo: cada teste começa com ela zerada, e o teste da trava a enche de propósito.
const resetCpfLimit = () => db(`delete from "RateLimit" where action = 'revalle.signup-identity'`);
const cpfLimitKeys = () =>
  db(`select key from "RateLimit" where action = 'revalle.signup-identity' and key like 'id:%'`)
    .split('\n')
    .filter(Boolean);

const baseRows = [];
const extraLinks = [];

before(() => {
  assert.equal(
    appContainerEnv('NEXT_PRIVATE_REVALLE_IDENTITY_CHECK') || 'required',
    'required',
    'a stack está com a verificação de identidade desligada: este arquivo não vale nela',
  );
  cleanUp();
});

beforeEach(resetCpfLimit);

after(() => {
  cleanUp();

  for (const cpf of extraLinks) {
    db(`delete from "RevalleEmailLink" where cpf = ${sql(cpf)}`);
  }

  for (const email of baseRows) {
    baseSql(`delete from rh_colaboradores where email_corp = ${sql(email)}`);
  }
});

test('a página /signup mostra os campos CPF e data de nascimento', async () => {
  const res = await fetch(`${BASE_URL}/signup`, { headers: { 'Accept-Language': 'pt-BR' } });
  const html = await res.text();

  assert.equal(res.status, 200);
  assert.match(html, /name="revalleCpf"/);
  assert.match(html, /name="revalleBirthDate"/);
  assert.match(html, /placeholder="000\.000\.000-00"/);
  assert.match(html, /placeholder="dd\/mm\/aaaa"/);
});

test('a página /signup não leva o e-mail do admin para o navegador', async () => {
  const adminEmail = appContainerEnv('NEXT_PRIVATE_REVALLE_ADMIN_EMAIL').trim().toLowerCase();

  assert.ok(adminEmail, 'a stack precisa de NEXT_PRIVATE_REVALLE_ADMIN_EMAIL');

  const html = (await (await fetch(`${BASE_URL}/signup`)).text()).toLowerCase();

  assert.ok(html.includes('name="email"'), 'a página de cadastro não carregou');
  assert.ok(!html.includes(adminEmail), 'o e-mail do admin está no HTML do /signup');
  assert.ok(!html.includes('identityexemptemail'), 'o loader ainda manda o e-mail isento');
});

test('sem CPF e sem data: SIGNUP_IDENTITY_REQUIRED, e a conta não é criada', async () => {
  const email = newEmail('semdados');
  const res = await signup(email);

  assert.equal(res.status, 400, res.text);
  assert.equal(res.body.code, 'SIGNUP_IDENTITY_REQUIRED');
  assert.equal(res.body.message, MENSAGEM.REQUIRED);
  assert.equal(userCount(email), 0);

  // Faltando só um dos dois, ou em branco, é o mesmo caso.
  for (const fields of [
    { revalleCpf: CADASTRO.cpf },
    { revalleBirthDate: CADASTRO.birthDate },
    { revalleCpf: '  ', revalleBirthDate: '' },
  ]) {
    const partial = await signup(email, fields);

    assert.equal(partial.body.code, 'SIGNUP_IDENTITY_REQUIRED', JSON.stringify(fields));
  }

  assert.equal(userCount(email), 0);
});

test('CPF inválido, CPF certo com data errada e CPF fora da base: a mesma resposta, sem conta', async () => {
  const attempts = [
    { label: 'CPF com dígito errado', fields: { revalleCpf: '11144477736', revalleBirthDate: CADASTRO.birthDate } },
    { label: 'data errada', fields: { revalleCpf: CADASTRO.cpf, revalleBirthDate: '04/02/1991' } },
    { label: 'CPF fora da base', fields: { revalleCpf: FORA_DA_BASE, revalleBirthDate: CADASTRO.birthDate } },
    { label: 'data que não existe', fields: { revalleCpf: CADASTRO.cpf, revalleBirthDate: '31/02/1991' } },
    { label: 'data em outro formato', fields: { revalleCpf: CADASTRO.cpf, revalleBirthDate: '1991-02-03' } },
  ];

  const results = [];

  for (const { label, fields } of attempts) {
    const email = newEmail(`invalido${results.length}`);
    const res = await signup(email, fields);

    assert.equal(res.status, 400, `${label}: ${res.text}`);
    assert.equal(res.body.code, 'SIGNUP_IDENTITY_INVALID', label);
    assert.equal(res.body.message, MENSAGEM.INVALID, label);
    assert.equal(userCount(email), 0, label);
    assert.ok(!res.text.includes(fields.revalleCpf), `${label}: a resposta devolveu o CPF`);
    results.push(res.text);
  }

  // Nada na resposta distingue um erro do outro (nem um campo a mais).
  assert.equal(new Set(results).size, 1, results.join(' | '));
});

test('dados certos: conta criada, sem vínculo, com o CPF guardado até a confirmação', async () => {
  const email = newEmail('certo');
  const res = await signupColaborador({ name: 'Teste Cadastro', email, password: PASSWORD });

  assert.equal(res.status, 201, await res.text());
  assert.equal(userCount(email), 1);
  assert.equal(linkOf(email), '');
  assert.equal(db(`select count(*) from "RevalleEmailLink" where cpf = ${sql(CADASTRO.cpf)}`), '0');
  assert.equal(pendingOf(email), CADASTRO.cpf);
  assert.equal(db(`select "emailVerified" is null from "User" where email = ${sql(email)}`), 't');
});

test('confirmando o e-mail o vínculo nasce e a primeira assinatura não pede CPF', async () => {
  const email = newEmail('confirma');

  assert.equal((await signupColaborador({ name: 'Teste Cadastro', email, password: PASSWORD })).status, 201);

  // Antes de confirmar, quem recebe um documento neste e-mail ainda é mandado ao CPF (o contraste do teste).
  const unconfirmed = await createEnvelope({ recipients: [{ email }] });
  const [pendingRecipient] = await distribute(unconfirmed.id);
  const pendingState = await trpc('revalle.gate.acceptTerm', { token: pendingRecipient.token, termVersion: '1' });

  assert.equal(pendingState.body.result.data.json.status, 'IDENTITY_REQUIRED', pendingState.text);

  const verified = await confirmEmail(email);

  assert.equal(verified.status, 200, await verified.text());
  assert.equal(linkOf(email), CADASTRO.cpf);
  assert.equal(pendingOf(email), '', 'a linha pendente deveria ter sido apagada');

  const envelope = await createEnvelope({ recipients: [{ email }] });
  const [recipient] = await distribute(envelope.id);
  const state = await trpc('revalle.gate.acceptTerm', { token: recipient.token, termVersion: '1' });

  assert.equal(state.body.result.data.json.status, 'PASSED', state.text);

  const cookie = await signIn(email, PASSWORD);

  assert.ok(cookie, 'a conta confirmada deveria entrar');
});

test('sem confirmar não há vínculo: o mesmo CPF em outro e-mail é aceito e quem confirma primeiro fica com ele', async () => {
  const first = newEmail('corrida-a');
  const second = newEmail('corrida-b');

  assert.equal((await signupColaborador({ name: 'Teste Cadastro', email: first, password: PASSWORD })).status, 201);
  // Segundo cadastro com o mesmo CPF, sem o ajudante (que soltaria o vínculo): nada foi vinculado, então é aceito.
  assert.equal((await signup(second, withIdentity(CADASTRO))).status, 201);
  assert.equal(db(`select count(*) from "RevalleEmailLink" where cpf = ${sql(CADASTRO.cpf)}`), '0');

  assert.equal((await confirmEmail(second)).status, 200);
  assert.equal(linkOf(second), CADASTRO.cpf);

  // O outro confirma depois: não falha, não cria vínculo, a linha pendente some e a conta fica confirmada.
  const late = await confirmEmail(first);

  assert.equal(late.status, 200, await late.text());
  assert.equal(linkOf(first), '');
  assert.equal(linkOf(second), CADASTRO.cpf);
  assert.equal(db(`select count(*) from "RevalleEmailLink" where cpf = ${sql(CADASTRO.cpf)}`), '1');
  assert.equal(pendingOf(first), '');
  assert.ok(await signIn(first, PASSWORD), 'a conta que perdeu o vínculo também entra');
});

test('CPF já vinculado a outro e-mail: SIGNUP_IDENTITY_CONFLICT, sem conta', async () => {
  // Outro e-mail já confirmou com este CPF (vínculo criado à mão, para o teste não depender dos anteriores).
  const owner = newEmail('dono');

  db(`delete from "RevalleEmailLink" where cpf = ${sql(CADASTRO.cpf)}`);
  db(
    `insert into "RevalleEmailLink" (id, email, cpf) values (${sql(randomUUID())}, ${sql(owner)}, ${sql(CADASTRO.cpf)})`,
  );

  const email = newEmail('conflito');
  const res = await signup(email, withIdentity(CADASTRO));

  assert.equal(res.status, 400, res.text);
  assert.equal(res.body.code, 'SIGNUP_IDENTITY_CONFLICT');
  assert.equal(res.body.message, MENSAGEM.CONFLICT);
  assert.equal(userCount(email), 0);
  assert.equal(linkOf(owner), CADASTRO.cpf, 'o vínculo existente não pode mudar');
});

test('CPF com outro e-mail na base: SIGNUP_IDENTITY_CONFLICT, sem conta', async () => {
  const email = newEmail('outro-email-na-base');
  const res = await signup(email, withIdentity(JOAO));

  assert.equal(res.status, 400, res.text);
  assert.equal(res.body.code, 'SIGNUP_IDENTITY_CONFLICT');
  assert.equal(res.body.message, MENSAGEM.CONFLICT);
  assert.equal(userCount(email), 0);

  // Com a data errada o CONFLITO não aparece: quem não sabe a data não descobre que o CPF tem outro e-mail.
  const wrong = await signup(email, { revalleCpf: JOAO.cpf, revalleBirthDate: '21/11/1985' });

  assert.equal(wrong.body.code, 'SIGNUP_IDENTITY_INVALID');
});

test('e-mail do admin cria a conta sem CPF', async () => {
  const adminEmail = appContainerEnv('NEXT_PRIVATE_REVALLE_ADMIN_EMAIL').trim();

  assert.ok(adminEmail, 'a stack precisa de NEXT_PRIVATE_REVALLE_ADMIN_EMAIL');

  const existed = userCount(adminEmail.toLowerCase()) > 0;
  // Caixa mista: a comparação é pelo e-mail normalizado.
  const res = await signup(adminEmail.toUpperCase().replace(/@.*/, (domain) => domain.toLowerCase()));

  if (existed) {
    assert.equal(res.body.code, 'ALREADY_EXISTS', res.text);

    return;
  }

  assert.equal(res.status, 201, res.text);
  // Conta criada só por este teste: sai para não segurar o e-mail do admin da stack.
  db(`delete from "User" where email = ${sql(adminEmail.toLowerCase())}`);
});

test('e-mail que já passou pelo portão (vínculo existente) cria a conta sem CPF, e ignora o que vier junto', async () => {
  const linked = newEmail('vinculado');
  const cpf = `9${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;

  db(`insert into "RevalleEmailLink" (id, email, cpf) values (${sql(randomUUID())}, ${sql(linked)}, ${sql(cpf)})`);
  extraLinks.push(cpf);

  const res = await signup(linked);

  assert.equal(res.status, 201, res.text);
  assert.equal(pendingOf(linked), '');

  // Mandando CPF e data, mesmo errados: o vínculo já prova a identidade, nada é conferido nem guardado.
  const other = newEmail('vinculado2');
  const otherCpf = `8${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;

  db(`insert into "RevalleEmailLink" (id, email, cpf) values (${sql(randomUUID())}, ${sql(other)}, ${sql(otherCpf)})`);
  extraLinks.push(otherCpf);

  const withData = await signup(other, { revalleCpf: '11144477736', revalleBirthDate: '01/01/2000' });

  assert.equal(withData.status, 201, withData.text);
  assert.equal(pendingOf(other), '');
  assert.equal(linkOf(other), otherCpf);
  assert.equal(cpfLimitKeys().length, 0, 'e-mail vinculado não deve gastar a trava por CPF');
});

test('e-mail presente na base cria a conta sem CPF', async () => {
  const email = newEmail('na-base');

  baseRows.push(email);
  baseSql(
    `insert into rh_colaboradores (cpf_completo, nome_completo, nascimento, status_rh, email_corp) values ('00000000191', 'Teste Cadastro na Base', '1980-01-01', 'ativo', ${sql(email)})`,
  );

  const res = await signup(email);

  assert.equal(res.status, 201, res.text);
  // Nada de CPF guardado: o vínculo só nasce na confirmação, e só para quem informou CPF.
  assert.equal(pendingOf(email), '');
  assert.equal(linkOf(email), '');
});

test('e-mail presente na base que manda CPF e data também: cria, não confere, não guarda e não gasta tentativa', async () => {
  const email = newEmail('na-base-com-cpf');

  baseRows.push(email);
  baseSql(
    `insert into rh_colaboradores (cpf_completo, nome_completo, nascimento, status_rh, email_corp) values ('00000000272', 'Teste Cadastro na Base 2', '1981-02-02', 'ativo', ${sql(email)})`,
  );
  db(`delete from "RevalleEmailLink" where cpf = ${sql(MARIA.cpf)}`);

  // CPF e data certos de outra pessoa (Maria) e, depois, dados errados: o e-mail da base prova a identidade nos dois casos.
  const withOtherPerson = await signup(email, withIdentity(MARIA));

  assert.equal(withOtherPerson.status, 201, withOtherPerson.text);
  assert.equal(pendingOf(email), '', 'o CPF que veio junto não deveria ser guardado');

  const other = newEmail('na-base-com-cpf-2');

  baseRows.push(other);
  baseSql(
    `insert into rh_colaboradores (cpf_completo, nome_completo, nascimento, status_rh, email_corp) values ('00000000353', 'Teste Cadastro na Base 3', '1982-03-03', 'ativo', ${sql(other)})`,
  );

  const wrong = await signup(other, { revalleCpf: '11144477736', revalleBirthDate: '01/01/2000' });

  assert.equal(wrong.status, 201, wrong.text);
  assert.equal(cpfLimitKeys().length, 0, 'e-mail da base não deve gastar a trava por CPF');
});

test('colaborador desligado na base também se cadastra (a situação não bloqueia)', async () => {
  const email = newEmail('desligada');
  const res = await signup(email, withIdentity(ANA));

  assert.equal(res.status, 201, res.text);
  assert.equal(pendingOf(email), ANA.cpf);
});

test('colaborador sem e-mail na base se cadastra com outro e-mail (a base sem e-mail não é conflito)', async () => {
  const email = newEmail('maria');

  db(`delete from "RevalleEmailLink" where cpf = ${sql(MARIA.cpf)}`);

  const res = await signup(email, withIdentity(MARIA));

  assert.equal(res.status, 201, res.text);
  assert.equal(pendingOf(email), MARIA.cpf);
});

test('domínio de fora continua SIGNUP_DISABLED, antes de olhar o CPF', async () => {
  const email = `fora-${SUFFIX}@example.com`;

  for (const fields of [{}, withIdentity(CADASTRO), { revalleCpf: '11144477736', revalleBirthDate: 'x' }]) {
    const res = await signup(email, fields);

    assert.equal(res.status, 400, res.text);
    assert.equal(res.body.code, 'SIGNUP_DISABLED', JSON.stringify(fields));
  }

  assert.equal(userCount(email), 0);
});

test('campos de identidade com tamanho ou tipo fora do contrato são recusados sem criar conta', async () => {
  const email = newEmail('contrato');

  for (const fields of [
    { revalleCpf: '1'.repeat(21), revalleBirthDate: CADASTRO.birthDate },
    { revalleCpf: CADASTRO.cpf, revalleBirthDate: '0'.repeat(11) },
    { revalleCpf: 11144477735, revalleBirthDate: CADASTRO.birthDate },
  ]) {
    const res = await signup(email, fields);

    assert.equal(res.status, 400, res.text);
  }

  assert.equal(userCount(email), 0);
});

test('confirmar duas vezes: um vínculo só, sem erro; a linha pendente que sobrou vira vínculo na repetição', async () => {
  const email = newEmail('repete');

  assert.equal((await signupColaborador({ name: 'Teste Cadastro', email, password: PASSWORD })).status, 201);

  const first = await confirmEmail(email);

  assert.equal(first.status, 200);
  assert.equal((await first.json()).state, 'VERIFIED');
  assert.equal(linkOf(email), CADASTRO.cpf);

  const second = await confirmEmail(email);

  assert.equal(second.status, 200, 'a confirmação repetida não pode falhar');
  assert.equal((await second.json()).state, 'ALREADY_VERIFIED');
  assert.equal(db(`select count(*) from "RevalleEmailLink" where email = ${sql(email)}`), '1');

  // Simula um vínculo que não chegou a ser gravado: o vínculo some e a linha pendente reaparece. Confirmar de novo refaz.
  const userId = db(`select id from "User" where email = ${sql(email)}`);

  db(`delete from "RevalleEmailLink" where email = ${sql(email)}`);
  db(`insert into "RevalleSignupIdentity" ("userId", cpf) values (${userId}, ${sql(CADASTRO.cpf)})`);

  const third = await confirmEmail(email);

  assert.equal(third.status, 200, await third.text());
  assert.equal(linkOf(email), CADASTRO.cpf);
  assert.equal(pendingOf(email), '');
  assert.equal(db(`select count(*) from "RevalleEmailLink" where cpf = ${sql(CADASTRO.cpf)}`), '1');
});

test('trava por CPF: passou de 10 conferências, o CPF recebe 429 até com os dados certos; outro CPF segue; a chave não tem o CPF', async () => {
  db(`delete from "RevalleEmailLink" where cpf in (${[BEATRIZ.cpf, MARIA.cpf].map(sql).join(',')})`);

  // Dez conferências com o CPF da Beatriz e datas erradas (cada uma de um e-mail e de um IP diferente).
  for (let i = 1; i <= 10; i += 1) {
    const res = await signup(newEmail(`trava${i}`), {
      revalleCpf: BEATRIZ.cpf,
      revalleBirthDate: `${String(i).padStart(2, '0')}/01/1980`,
    });

    assert.equal(res.body.code, 'SIGNUP_IDENTITY_INVALID', `tentativa ${i}: ${res.text}`);
  }

  // A 11ª, com CPF e data certos, também é barrada (e com o CPF mascarado, que é o mesmo CPF).
  for (const cpf of [BEATRIZ.cpf, '683.401.927-87']) {
    const email = newEmail('trava-certo');
    const limited = await signup(email, { revalleCpf: cpf, revalleBirthDate: BEATRIZ.birthDate });

    assert.equal(limited.status, 429, limited.text);
    assert.equal(limited.body.code, 'SIGNUP_IDENTITY_LIMITED');
    assert.equal(limited.body.message, MENSAGEM.LIMITED);
    assert.equal(userCount(email), 0);
    assert.ok(!limited.text.includes(cpf), 'a resposta devolveu o CPF');
  }

  // Outro CPF continua se cadastrando.
  const other = newEmail('trava-outro');
  const ok = await signup(other, withIdentity(MARIA));

  assert.equal(ok.status, 201, ok.text);
  assert.equal(pendingOf(other), MARIA.cpf);

  // O banco guarda só o código embaralhado de cada CPF (64 hex) e nenhum IP de verdade.
  const keys = cpfLimitKeys();

  assert.equal(keys.length, 2, keys.join(' | '));

  for (const key of keys) {
    assert.match(key, /^id:[0-9a-f]{64}$/);
  }

  assert.equal(
    db(
      `select count(*) from "RateLimit" where action = 'revalle.signup-identity' and (key like '%${BEATRIZ.cpf}%' or key like '%${MARIA.cpf}%' or key like 'ip:203.%')`,
    ),
    '0',
  );
});

test('o log do app não tem o CPF nem a data de nascimento', () => {
  const logs = spawnSync('docker', ['logs', '--since', STARTED_AT, 'revsign-hml-documenso-1'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  // O app escreve em stdout e em stderr: os dois contam.
  const text = `${logs.stdout}\n${logs.stderr}`;

  assert.ok(text.length > 0, 'o log veio vazio: a conferência não prova nada');

  // Cadastro recusado vira um aviso fixo com só o código do motivo: sem CPF, sem data e sem e-mail.
  const refusals = text.split('\n').filter((line) => line.includes('cadastro recusado pela conferência de identidade'));
  const codes = new Set(refusals.map((line) => JSON.parse(line).code));

  for (const code of [
    'SIGNUP_IDENTITY_REQUIRED',
    'SIGNUP_IDENTITY_INVALID',
    'SIGNUP_IDENTITY_CONFLICT',
    'SIGNUP_IDENTITY_LIMITED',
  ]) {
    assert.ok(codes.has(code), `faltou o aviso do cadastro recusado com ${code}`);
  }

  for (const line of refusals) {
    assert.deepEqual(
      Object.keys(JSON.parse(line)).sort(),
      ['code', 'hostname', 'level', 'msg', 'pid', 'time'],
      'o aviso só pode ter o código do motivo',
    );
  }

  for (const secret of [
    CADASTRO.cpf,
    '111.444.777-35',
    CADASTRO.birthDate,
    '1991-02-03',
    JOAO.cpf,
    JOAO.birthDate,
    '1985-11-20',
    MARIA.cpf,
    BEATRIZ.cpf,
    ANA.cpf,
    FORA_DA_BASE,
  ]) {
    assert.ok(!text.includes(secret), `o log do app traz ${secret.slice(0, 3)}…`);
  }
});
