// Certificado e log selados: datas no padrão brasileiro e QR sempre visível (Task 1, Fase 4). Rodam contra a stack local.
// Extrai texto e imagens do PDF final com poppler num container alpine (como scripts/revalle/verify-signed-pdf.sh).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, beforeEach, test } from 'node:test';

import { api, BASE_URL, completeWithCode, createEnvelope, db, distribute, trpc } from './helpers.mjs';

const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const poppler = (dir, script) =>
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${dir}:/pdf:ro`,
      'alpine:3.22',
      'sh',
      '-c',
      `apk add --no-cache -q poppler-utils >/dev/null && ${script}`,
    ],
    { encoding: 'utf8' },
  );

let dir;
let pages;

beforeEach(() => {
  db('delete from "RateLimit"');
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
});

before(async () => {
  db('delete from "RateLimit"');
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);

  const email = `cert-${Date.now()}@revalle.com.br`;
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
  assert.equal((await completeWithCode({ token, documentId, email })).status, 200);

  for (let i = 0; i < 60; i += 1) {
    if ((await api('GET', `/envelope/${created.id}`)).body.status === 'COMPLETED') {
      break;
    }

    await sleep(3000);
  }

  const item = created.envelope.envelopeItems[0];
  const res = await fetch(`${BASE_URL}/api/v2-beta/envelope/item/${item.id}/download?version=signed`, {
    headers: { Authorization: `Bearer ${process.env.REVSIGN_API_TOKEN}` },
  });

  assert.equal(res.status, 200);

  dir = mkdtempSync(path.join(tmpdir(), 'cert-'));
  writeFileSync(path.join(dir, 'signed.pdf'), Buffer.from(await res.arrayBuffer()));

  const total = Number(poppler(dir, 'pdfinfo /pdf/signed.pdf').match(/^Pages:\s+(\d+)/m)[1]);

  // Páginas do certificado e do log: tudo depois do original (1 página do example.pdf pode variar; pega de 2 em diante).
  pages = { total, text: poppler(dir, `pdftotext -f 2 -l ${total} -layout /pdf/signed.pdf -`) };
  pages.images = poppler(dir, `pdfimages -f 2 -l ${total} -list /pdf/signed.pdf`);
});

test('nenhuma data no formato ISO nem AM/PM nas páginas do certificado e do log', () => {
  assert.doesNotMatch(pages.text, /\d{4}-\d{2}-\d{2}/);
  assert.doesNotMatch(pages.text, /\b(AM|PM)\b/);
  assert.doesNotMatch(pages.text, /\d{2}\/\d{2}\/\d{4}, \d/);
});

test('existem datas dd/MM/yyyy HH:mm', () => {
  assert.match(pages.text, /\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/);
});

test('qr-always: com hidePoweredBy ligado, o certificado traz imagem (QR) e o ID do envelope', () => {
  const rows = pages.images.split('\n').filter((l) => /^\s*\d+\s+\d+\s+image/.test(l));

  assert.ok(rows.length >= 1, `sem imagens:\n${pages.images}`);
  assert.match(pages.text, /Envelope ID|ID do Envelope/);
});

test('o certificado declara o fuso e o log mostra America/Bahia', () => {
  assert.match(pages.text, /Horários em horário de Brasília \(UTC.3\)/);
  assert.match(pages.text, /America\/Bahia \(horário de Brasília\)/);
});
