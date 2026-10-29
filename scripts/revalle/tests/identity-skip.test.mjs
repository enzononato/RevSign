// Homologação sem base (NEXT_PRIVATE_REVALLE_IDENTITY_CHECK=disabled): o portão pula o CPF e grava na auditoria
// "Verificação de identidade desativada nesta instalação (não verificado)".
// Só roda com a stack subida em modo disabled e REVSIGN_IDENTITY_CHECK_DISABLED=1 (ver revalle/docs/testes.md).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createEnvelope, db, distribute, trpc } from './helpers.mjs';

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
