// Certificado e log selados: datas no padrão brasileiro e QR sempre visível (Task 1, Fase 4) e linhas da prova
// congelada de cada destinatário (Task 7). Rodam contra a stack local.
// Extrai texto e imagens do PDF final com poppler num container alpine (como scripts/revalle/verify-signed-pdf.sh).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, beforeEach, test } from 'node:test';

import { api, BASE_URL, completeWithCode, createEnvelope, db, distribute, trpc } from './helpers.mjs';

const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const BEATRIZ = { cpf: '68340192787', birthDate: '09/09/1988' };
const FERNANDO = { cpf: '93457210888', birthDate: '31/12/1999' };
const CPFS = [MARIA, BEATRIZ, FERNANDO].map((person) => `'${person.cpf}'`).join(',');
const maskCpf = (cpf) => `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**`;
const LABELS = [
  'CPF',
  'Matrícula',
  'Cargo',
  'Setor',
  'Unidade',
  'Situação',
  'Verificação',
  'Termo aceito',
  'Localização aproximada (IP)',
  'Localização do aparelho',
  'Código de verificação',
];
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
let signers;
let originalSha256;

beforeEach(() => {
  db('delete from "RateLimit"');
  db(`delete from "RevalleEmailLink" where cpf in (${CPFS})`);
});

// Três destinatários (Task 9 depende da paginação): quem assina digitando, quem assina só com o carimbo
// (aparelho com localização) e quem aprova (aparelho recusou a localização).
before(async () => {
  db('delete from "RateLimit"');
  db(`delete from "RevalleEmailLink" where cpf in (${CPFS})`);

  const stamp = Date.now();
  signers = [
    { name: 'Cert Um', role: 'SIGNER', person: MARIA, typed: 'Teste' },
    {
      name: 'Cert Dois',
      role: 'SIGNER',
      person: BEATRIZ,
      geolocation: { status: 'GRANTED', lat: -9.41672, lon: -40.50331, accuracyM: 25 },
    },
    { name: 'Cert Tres', role: 'APPROVER', person: FERNANDO, typed: 'Teste', geolocation: { status: 'DENIED' } },
  ].map((signer, index) => ({ ...signer, email: `cert-${stamp}-${index}@revalle.com.br` }));

  const created = await createEnvelope({
    recipients: signers.map(({ email, name, role }) => ({ email, name, role })),
  });

  assert.equal(created.status, 200, created.text);

  const recipients = await distribute(created.id);
  const documentId = Number.parseInt(created.envelope.secondaryId.split('_')[1], 10);

  for (const signer of signers) {
    const recipient = recipients.find((r) => r.email === signer.email);
    const field = created.envelope.fields.find((f) => f.recipientId === recipient.id && f.type === 'SIGNATURE');
    const { token } = recipient;

    db('delete from "RateLimit"');
    await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' });
    await trpc('revalle.gate.verifyIdentity', { token, ...signer.person });
    await trpc('revalle.gate.confirmIdentity', { token, isMe: true });

    if (signer.typed) {
      const signed = await trpc('envelope.field.sign', {
        token,
        fieldId: field.id,
        fieldValue: { type: 'SIGNATURE', value: signer.typed },
      });

      assert.equal(signed.status, 200, signed.text);
    }

    const extra = signer.geolocation ? { revalleGeolocation: signer.geolocation } : {};
    const completed = await completeWithCode({ token, documentId, email: signer.email, extra });

    assert.equal(completed.status, 200, completed.text);

    signer.code = db(
      `select p."verificationCode" from "RevalleSignatureProof" p where p."recipientId" = ${recipient.id}`,
    );
    assert.match(signer.code, /^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
  }

  originalSha256 = db(
    `select h."originalSha256" from "RevalleDocumentHash" h join "EnvelopeItem" i on i.id = h."envelopeItemId" where i."envelopeId" = '${created.id}'`,
  );
  assert.match(originalSha256, /^[0-9a-f]{64}$/);

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
  // pdftotext separa as páginas com form feed; as da tabela do certificado trazem o hash no cabeçalho.
  pages.certificate = pages.text.split('\f').filter((page) => page.includes('SHA-256 do original'));
  pages.certificateText = pages.certificate.join('\n');
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

test('cabeçalho com o SHA-256 do original e rodapé com a atribuição DB-IP em cada página da tabela', (t) => {
  t.diagnostic(`páginas da tabela do certificado: ${pages.certificate.length}`);
  assert.ok(pages.certificate.length >= 1, 'nenhuma página do certificado com o hash no cabeçalho');

  for (const page of pages.certificate) {
    assert.ok(page.includes(`SHA-256 do original: ${originalSha256}`), 'hash original ausente ou diferente do banco');
    assert.match(page, /IP Geolocation by DB-IP \(https:\/\/db-ip\.com\)/);
  }
});

test('cada destinatário tem as linhas da prova com CPF mascarado e o código de verificação', () => {
  const text = pages.certificateText;
  const count = (label) => text.split(`${label}:`).length - 1;

  for (const label of LABELS) {
    assert.equal(count(label), 3, `rótulo "${label}" deveria aparecer 3 vezes`);
  }

  assert.equal(count('Assinatura visual'), 2, 'só quem tem papel SIGNER tem "Assinatura visual"');
  assert.equal(count('Assinou em'), 2);
  assert.equal(count('Aprovou em'), 1);

  for (const signer of signers) {
    assert.ok(text.includes(maskCpf(signer.person.cpf)), `CPF mascarado de ${signer.name}`);
    assert.ok(text.includes(signer.code), `código de ${signer.name}`);
    assert.ok(!pages.text.includes(signer.person.cpf), 'CPF completo não pode aparecer');
    assert.ok(
      !pages.text.includes(`${signer.person.cpf.slice(0, 3)}.${signer.person.cpf.slice(3, 6)}`),
      'CPF completo',
    );
  }

  assert.match(text, /Assinatura visual:\s+texto digitado/);
  assert.match(text, /Assinatura visual:\s+somente carimbo/);
  assert.match(text, /Localização do aparelho:\s+não autorizada/);
  assert.match(text, /Localização do aparelho:\s+-9,4167, -40,5033/);
  assert.match(text, /\(±25[\s\u00a0]m\)/);
  assert.equal(text.split('não identificada').length - 1, 3, 'IP de teste (203.0.113.7) não tem local');
  assert.match(text, /Termo aceito:\s+Versão 1 em \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/);
  assert.match(text, /Verificação:\s+Link por e-mail \(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}\)/);
  assert.match(text, /Código por e-mail \(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}\)/);
  assert.match(text, /Situação:\s+ativo/);
});

test('nenhum destinatário é cortado entre páginas: nome, CPF e código ficam na mesma página', () => {
  for (const signer of signers) {
    const withName = pages.certificate.filter((page) => page.includes(signer.name));

    assert.equal(withName.length, 1, `${signer.name} deveria aparecer em uma única página`);
    assert.ok(withName[0].includes(maskCpf(signer.person.cpf)), `CPF de ${signer.name} em outra página`);
    assert.ok(withName[0].includes(signer.code), `código de ${signer.name} em outra página`);
  }
});
