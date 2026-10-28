#!/usr/bin/env node
// Smoke test do fluxo de assinatura do RevSign (sem dependências; Node 24+).
//
// Cria um documento com um signatário, envia, assina pelo token do destinatário
// (as mesmas rotas da página de assinatura), espera a selagem e baixa o PDF
// original e o final. Depois, verifique com scripts/revalle/verify-signed-pdf.sh.
//
// Uso:
//   REVSIGN_URL=http://localhost:3000 REVSIGN_API_TOKEN=api_... \
//   SIGNER_EMAIL=teste@exemplo.com node scripts/revalle/smoke-test.mjs [saida/]
//
// Variáveis opcionais: SIGNER_NAME, PDF_PATH (padrão: assets/example.pdf),
// SEND_EMAIL=false (só gera o link, sem e-mail).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = (process.env.REVSIGN_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const API_TOKEN = process.env.REVSIGN_API_TOKEN;
const SIGNER_EMAIL = process.env.SIGNER_EMAIL ?? 'signatario.teste@revalle.local';
const SIGNER_NAME = process.env.SIGNER_NAME ?? 'Signatário de Teste';
const PDF_PATH = process.env.PDF_PATH ?? 'assets/example.pdf';
const SEND_EMAIL = process.env.SEND_EMAIL !== 'false';
const OUT_DIR = process.argv[2] ?? 'smoke-output';
const SEAL_TIMEOUT_MS = 180_000;

if (!API_TOKEN) {
  console.error('Defina REVSIGN_API_TOKEN (token de API do time, criado em Configurações > API).');
  process.exit(2);
}

const API = `${BASE_URL}/api/v2-beta`;
const authHeaders = { Authorization: `Bearer ${API_TOKEN}` };

const step = (message) => console.log(`- ${message}`);

const request = async (method, url, { headers = {}, body } = {}) => {
  const res = await fetch(url, { method, headers, body });

  if (!res.ok) {
    throw new Error(`${method} ${url} => ${res.status}: ${await res.text()}`);
  }

  return res;
};

const api = async (method, route, data) => {
  const res = await request(method, `${API}${route}`, {
    headers: data ? { ...authHeaders, 'Content-Type': 'application/json' } : authHeaders,
    body: data ? JSON.stringify(data) : undefined,
  });

  return await res.json();
};

// Rotas públicas do signatário (autenticadas só pelo token do link).
const trpcMutation = async (procedure, input) => {
  await request('POST', `${BASE_URL}/api/trpc/${procedure}`, {
    headers: { Origin: new URL(BASE_URL).origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ json: input }),
  });
};

const download = async (envelopeItemId, version) => {
  const res = await request('GET', `${API}/envelope/item/${envelopeItemId}/download?version=${version}`, {
    headers: authHeaders,
  });

  const bytes = new Uint8Array(await res.arrayBuffer());

  if (Buffer.from(bytes.subarray(0, 5)).toString() !== '%PDF-') {
    throw new Error(`Download ${version} não é um PDF`);
  }

  return bytes;
};

const main = async () => {
  const pdf = await readFile(PDF_PATH);
  const title = `[SMOKE] ${new Date().toISOString()}`;

  step(`criando documento "${title}"`);

  const formData = new FormData();
  formData.append(
    'payload',
    JSON.stringify({
      title,
      type: 'DOCUMENT',
      meta: SEND_EMAIL ? undefined : { distributionMethod: 'NONE' },
      recipients: [
        {
          email: SIGNER_EMAIL,
          name: SIGNER_NAME,
          role: 'SIGNER',
          fields: [{ type: 'SIGNATURE', page: 1, positionX: 10, positionY: 80, width: 30, height: 8 }],
        },
      ],
    }),
  );
  formData.append('files', new File([pdf], path.basename(PDF_PATH), { type: 'application/pdf' }));

  const created = await (
    await request('POST', `${API}/envelope/create`, { headers: authHeaders, body: formData })
  ).json();

  const envelope = await api('GET', `/envelope/${created.id}`);
  const envelopeItemId = envelope.envelopeItems[0].id;
  const documentId = Number.parseInt(envelope.secondaryId.split('_')[1], 10);

  step(`enviando (${SEND_EMAIL ? 'com e-mail' : 'só link'})`);

  const distributed = await api('POST', '/envelope/distribute', { envelopeId: created.id });
  const recipient = distributed.recipients[0];
  const field = envelope.fields.find((f) => f.recipientId === recipient.id && f.type === 'SIGNATURE');

  console.log(`  link de assinatura: ${recipient.signingUrl}`);

  step('assinando como destinatário');

  await trpcMutation('envelope.field.sign', {
    token: recipient.token,
    fieldId: field.id,
    fieldValue: { type: 'SIGNATURE', value: SIGNER_NAME },
  });
  await trpcMutation('recipient.completeDocumentWithToken', { token: recipient.token, documentId });

  step('aguardando selagem');

  const deadline = Date.now() + SEAL_TIMEOUT_MS;
  let status = '';

  while (Date.now() < deadline) {
    status = (await api('GET', `/envelope/${created.id}`)).status;

    if (status === 'COMPLETED') {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  if (status !== 'COMPLETED') {
    throw new Error(`Documento não foi selado em ${SEAL_TIMEOUT_MS / 1000}s (status: ${status})`);
  }

  await mkdir(OUT_DIR, { recursive: true });

  const originalPath = path.join(OUT_DIR, 'original.pdf');
  const finalPath = path.join(OUT_DIR, 'final.pdf');

  await writeFile(originalPath, await download(envelopeItemId, 'original'));
  await writeFile(finalPath, await download(envelopeItemId, 'signed'));

  step(`ok: ${envelope.id} selado`);
  console.log(`  original: ${originalPath}`);
  console.log(`  final:    ${finalPath}`);
};

main().catch((error) => {
  console.error(`FALHA: ${error.message}`);
  process.exit(1);
});
