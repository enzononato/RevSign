// Tela do portão (Task 7, Fase 3): a página de assinatura não mostra nada do documento nem registra abertura antes do portão.
// Requer REVSIGN_API_TOKEN. Pessoa fictícia: revalle/colaboradores/dev-seed.sql.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { BASE_URL, createEnvelope, db, distribute, trpc } from './helpers.mjs';

const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const unique = () => `gatepage-${Date.now()}-${Math.floor(Math.random() * 1e6)}@revalle.com.br`;
const gate = (procedure, input) => trpc(`revalle.gate.${procedure}`, input);
const page = async (token) => (await fetch(`${BASE_URL}/sign/${token}`)).text();

beforeEach(() => {
  db('delete from "RateLimit"');
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
});

test('gate-page: antes do portão a página não traz documento; depois traz, e a abertura só é registrada depois', async () => {
  const title = `[TESTE] titulo-secreto-${Date.now()}`;
  const created = await createEnvelope({ recipients: [{ email: unique() }], title });

  assert.equal(created.status, 200, created.text);

  const [recipient] = await distribute(created.id);
  const { token } = recipient;

  const before = await page(token);

  assert.match(before, /Antes de assinar/);
  assert.ok(!before.includes(title), 'o título do documento não pode aparecer antes do portão');
  assert.ok(!before.includes('/api/files/'), 'nenhuma URL de arquivo antes do portão');

  const opened = () =>
    db(
      `select count(*) from "DocumentAuditLog" where "envelopeId" = '${created.id}' and type in ('DOCUMENT_OPENED','DOCUMENT_VIEWED')`,
    );

  assert.equal(opened(), '0');

  for (const sub of ['complete', 'rejected']) {
    const res = await fetch(`${BASE_URL}/sign/${token}/${sub}`, { redirect: 'manual' });
    const body = await res.text();

    assert.ok(
      res.status >= 300 && res.status < 400,
      `/${sub} deve redirecionar antes do portão (status ${res.status})`,
    );
    assert.ok(res.headers.get('location')?.endsWith(`/sign/${token}`));
    assert.ok(!body.includes(title) && !body.includes('/api/files/'));
  }

  const expired = await fetch(`${BASE_URL}/sign/${token}/expired`, { redirect: 'manual' });

  assert.ok(!(await expired.text()).includes(title), 'o título não pode aparecer em /expired antes do portão');
  assert.equal(opened(), '0');

  assert.equal((await gate('acceptTerm', { token, termVersion: '1' })).status, 200);

  const mid = await page(token);

  assert.match(mid, /Confirme que é você/);
  assert.ok(!mid.includes(title));
  assert.equal(opened(), '0');

  const verified = await gate('verifyIdentity', { token, cpf: MARIA.cpf, birthDate: MARIA.birthDate });

  assert.equal(verified.body?.result?.data?.json?.status, 'IDENTITY_CONFIRM', verified.text);
  assert.ok(!(await page(token)).includes(title));
  assert.equal(opened(), '0');

  const confirmed = await gate('confirmIdentity', { token, isMe: true });

  assert.equal(confirmed.body?.result?.data?.json?.status, 'PASSED', confirmed.text);

  const after = await page(token);

  assert.ok(!after.includes('Antes de assinar'));
  assert.ok(after.includes(title), 'depois do portão a página normal traz o documento');

  const firstOpen = db(
    `select min(extract(epoch from "createdAt")) from "DocumentAuditLog" where "envelopeId" = '${created.id}' and type in ('DOCUMENT_OPENED','DOCUMENT_VIEWED')`,
  );
  const gatePassed = db(
    `select max(extract(epoch from "createdAt")) from "DocumentAuditLog" where "envelopeId" = '${created.id}' and type in ('REVALLE_TERM_ACCEPTED','REVALLE_IDENTITY_CONFIRMED')`,
  );

  assert.ok(
    firstOpen && gatePassed && Number(firstOpen) >= Number(gatePassed),
    `abertura (${firstOpen}) antes do portão (${gatePassed})`,
  );
});
