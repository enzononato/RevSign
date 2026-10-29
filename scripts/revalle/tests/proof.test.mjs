// Prova congelada por signatário (Task 3, Fase 4). Roda contra a stack local.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, before, beforeEach, test } from 'node:test';

import { api, completeWithCode, createEnvelope, db, distribute, signIn, trpc, trpcAs } from './helpers.mjs';

const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const admin = { email: process.env.REVSIGN_ADMIN_EMAIL, password: process.env.REVSIGN_ADMIN_PASSWORD };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Atualiza a base fictícia como superusuário (o usuário do app só lê).
const baseSql = (sql) =>
  execFileSync(
    'docker',
    ['exec', 'revsign-hml-colaboradores-db-1', 'psql', '-U', 'postgres', '-d', 'colaboradores', '-At', '-c', sql],
    { encoding: 'utf8' },
  ).trim();

const signerFlow = async ({ beforeComplete } = {}) => {
  const email = `proof-${Date.now()}@revalle.com.br`;
  const created = await createEnvelope({ recipients: [{ email }] });

  assert.equal(created.status, 200, created.text);

  const [recipient] = await distribute(created.id);
  const documentId = Number.parseInt(created.envelope.secondaryId.split('_')[1], 10);
  const field = created.envelope.fields.find((f) => f.recipientId === recipient.id && f.type === 'SIGNATURE');
  const { token } = recipient;

  await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' });
  await trpc('revalle.gate.verifyIdentity', { token, ...MARIA });
  await trpc('revalle.gate.confirmIdentity', { token, isMe: true });
  assert.equal(
    (await trpc('envelope.field.sign', { token, fieldId: field.id, fieldValue: { type: 'SIGNATURE', value: 'Teste' } }))
      .status,
    200,
  );
  await beforeComplete?.();
  assert.equal((await completeWithCode({ token, documentId, email })).status, 200);

  return { envelopeId: created.id };
};

let envelopeId;
let proof;
let proofAfterBaseChange;
let originalCargo;
let resealed = false;
let proofBaseDown;

const readProof = (id) =>
  JSON.parse(
    db(
      `select row_to_json(p) from "RevalleSignatureProof" p join "Recipient" r on r.id = p."recipientId" where r."envelopeId" = '${id}'`,
    ) || 'null',
  );

beforeEach(() => {
  db('delete from "RateLimit"');
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
});

before(async () => {
  db('delete from "RateLimit"');
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
  originalCargo = baseSql(`select cargo_nome from rh_colaboradores where cpf_completo = '${MARIA.cpf}'`);

  const first = await signerFlow();

  envelopeId = first.envelopeId;
  proof = readProof(envelopeId);

  // Base do RH fora do ar no momento da conclusão: a prova ainda sai, com CPF mascarado e dados do RH nulos.
  db('delete from "RateLimit"');
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);

  try {
    const down = await signerFlow({
      beforeComplete: () => execFileSync('docker', ['stop', 'revsign-hml-colaboradores-db-1'], { stdio: 'ignore' }),
    });

    proofBaseDown = readProof(down.envelopeId);
  } finally {
    execFileSync('docker', ['start', 'revsign-hml-colaboradores-db-1'], { stdio: 'ignore' });

    for (let i = 0; i < 60; i += 1) {
      try {
        baseSql('select 1');
        break;
      } catch {
        await sleep(1000);
      }
    }
  }

  // O RH muda o cargo depois da assinatura.
  baseSql(`update rh_colaboradores set cargo_nome = 'Cargo Alterado Depois' where cpf_completo = '${MARIA.cpf}'`);

  // Reselagem pela rota admin quando há credenciais; sem elas a perna da reselagem é pulada.
  if (admin.email && admin.password) {
    for (let i = 0; i < 60; i += 1) {
      if ((await api('GET', `/envelope/${envelopeId}`)).body.status === 'COMPLETED') {
        break;
      }

      await sleep(3000);
    }

    const cookie = await signIn(admin.email, admin.password);

    resealed = (await trpcAs(cookie, 'mutation', 'admin.document.reseal', { id: envelopeId })).ok;
    await sleep(5000);
  }

  proofAfterBaseChange = readProof(envelopeId);
});

after(() => {
  baseSql(
    `update rh_colaboradores set cargo_nome = '${originalCargo.replaceAll("'", "''")}' where cpf_completo = '${MARIA.cpf}'`,
  );
});

test('a prova existe e traz o código de verificação no formato XXXX-XXXX', () => {
  assert.ok(proof, 'prova ausente');
  assert.match(proof.verificationCode, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
});

test('os dados do RH ficam congelados com o CPF mascarado', () => {
  assert.match(proof.employee.cpfMasked, /^\*\*\*\.\d{3}\.\d{3}-\*\*$/);
  assert.equal(proof.employee.nome, 'Maria Teste da Silva');
  assert.equal(proof.employee.cargo, originalCargo);
  assert.equal(proof.identityVerified, true);
  assert.ok(!JSON.stringify(proof).includes(MARIA.cpf), 'CPF completo na prova');
});

test('os fatores incluem link, código por e-mail e confirmação do colaborador', () => {
  const kinds = proof.factors.map((f) => f.factor);

  for (const kind of ['EMAIL_LINK', 'EMAIL_CODE', 'EMPLOYEE_CONFIRMATION']) {
    assert.ok(kinds.includes(kind), `fator ${kind} ausente`);
  }

  for (const f of proof.factors) {
    assert.ok(!Number.isNaN(Date.parse(f.at)));
  }
});

test('termo, aparelho, local e desenho', () => {
  assert.equal(proof.termVersion, '1');
  assert.ok(proof.termAcceptedAt);
  assert.ok(proof.device && proof.device.length > 0);
  assert.deepEqual(proof.deviceLocation, { status: 'NOT_REQUESTED' });
  // IP privado/de teste não localiza: aceita nulo, mas se vier deve ter o formato certo.
  assert.ok(proof.ipLocation === null || typeof proof.ipLocation === 'object');
  assert.equal(proof.drewSignature, proof.signatureKind === 'IMAGE');
});

test('base do RH fora do ar na conclusão: CPF mascarado presente, dados do RH nulos, identidade verificada', () => {
  assert.ok(proofBaseDown, 'prova ausente');
  assert.match(proofBaseDown.employee.cpfMasked, /^\*\*\*\.\d{3}\.\d{3}-\*\*$/);
  assert.equal(proofBaseDown.employee.cargo, null);
  assert.equal(proofBaseDown.employee.matricula, null);
  assert.equal(proofBaseDown.identityVerified, true);
});

test('o tipo de assinatura é registrado', () => {
  assert.ok(['IMAGE', 'TYPED', 'NONE'].includes(proof.signatureKind));
});

test('reselagem admin executada', (t) => {
  if (!admin.email || !admin.password) {
    t.skip('sem credenciais de admin');

    return;
  }

  assert.equal(resealed, true);
});

test('frozen: mudar o cargo na base depois da assinatura não altera a prova', () => {
  assert.equal(
    baseSql(`select cargo_nome from rh_colaboradores where cpf_completo = '${MARIA.cpf}'`),
    'Cargo Alterado Depois',
  );
  assert.equal(proofAfterBaseChange.employee.cargo, originalCargo);
  assert.equal(proofAfterBaseChange.verificationCode, proof.verificationCode);
  assert.deepEqual(proofAfterBaseChange.employee, proof.employee);
});
