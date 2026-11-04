// Homologação sem base (NEXT_PRIVATE_REVALLE_IDENTITY_CHECK=disabled): o portão pula o CPF e grava na auditoria
// "Verificação de identidade desativada nesta instalação (não verificado)".
// Só roda com a stack subida em modo disabled e REVSIGN_IDENTITY_CHECK_DISABLED=1 (ver revalle/docs/testes.md).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BASE_URL, createEnvelope, db, distribute, postSignup, trpc } from './helpers.mjs';

const enabled = process.env.REVSIGN_IDENTITY_CHECK_DISABLED === '1';

test(
  'IDENTITY_CHECK=disabled: SKIPPED com evento de auditoria (IP e navegador), uma vez só',
  enabled ? {} : { skip: 'stack não está em modo disabled (REVSIGN_IDENTITY_CHECK_DISABLED=1)' },
  async () => {
    db('delete from "RateLimit"');

    const email = `skip-${Date.now()}@revalle.com.br`;
    const created = await createEnvelope({ recipients: [{ email }] });

    assert.equal(created.status, 200, created.text);

    const [recipient] = await distribute(created.id);
    const accepted = await trpc('revalle.gate.acceptTerm', { token: recipient.token, termVersion: '1' });

    assert.equal(accepted.body?.result?.data?.json?.status, 'PASSED', accepted.text);
    assert.equal(
      db(`select "identityStatus" from "RevalleRecipientGate" where "recipientId" = ${recipient.id}`),
      'SKIPPED',
    );

    await trpc('revalle.gate.acceptTerm', { token: recipient.token, termVersion: '1' });

    assert.equal(
      db(
        `select count(*) || '|' || max("ipAddress") || '|' || max("userAgent") from "DocumentAuditLog" where "envelopeId" = '${created.id}' and type = 'REVALLE_IDENTITY_SKIPPED'`,
      ),
      '1|203.0.113.7|revsign-gate-test',
    );
  },
);

test(
  'IDENTITY_CHECK=disabled: o cadastro não pede CPF nem data e a página /signup esconde os campos',
  enabled ? {} : { skip: 'stack não está em modo disabled (REVSIGN_IDENTITY_CHECK_DISABLED=1)' },
  async () => {
    db('delete from "RateLimit"');

    const email = `skip-cadastro-${Date.now()}@revalle.com.br`;
    const created = await postSignup({ name: 'Teste Sem Conferencia', email, password: 'Revalle-Teste-2026!' });

    assert.equal(created.status, 201, created.text);
    assert.equal(
      db(
        `select count(*) from "RevalleSignupIdentity" s join "User" u on u.id = s."userId" where u.email = '${email}'`,
      ),
      '0',
    );

    const html = await (await fetch(`${BASE_URL}/signup`)).text();

    assert.ok(html.includes('name="email"'), 'a página de cadastro não carregou');
    assert.ok(!html.includes('name="revalleCpf"'), 'o campo de CPF deveria estar escondido');
    assert.ok(!html.includes('name="revalleBirthDate"'), 'o campo de data de nascimento deveria estar escondido');
  },
);
