#!/usr/bin/env node
// REVALLE (Fase 7): conferência das telas novas da Fase 7, em 390 px e 1280 px, num navegador de verdade (imagem do
// Playwright, como o `mobile-check`). Confere o diálogo de envio de NF (seletor de centro, sem "Deixar para o Financeiro",
// Enviar desabilitado até escolher a conta e o centro), o contador no menu, o cartão da Contabilidade, o cadastro com CPF
// e data de nascimento, e que nada rola para o lado. Guarda um print por tela.
//
// Prepara, a cada execução: uma conta nova da Contabilidade (desmarcada no fim), dois rascunhos de NF fictícia e uma NF
// enviada (esperando a Contabilidade). Nenhum envio pela tela: o diálogo é aberto e fechado, e os rascunhos ficam lá.
//
// Uso (na raiz do repo, com a stack local no ar, a lista de contas importada e as dependências instaladas):
//   REVSIGN_API_TOKEN=api_... REVSIGN_USER_EMAIL=... REVSIGN_USER_PASSWORD=... \
//   REVSIGN_ADMIN_EMAIL=... REVSIGN_ADMIN_PASSWORD=... node scripts/revalle/ui-check-f7.mjs [pasta-dos-prints]
// Variáveis: REVSIGN_URL (padrão http://localhost:3000), MOBILE_CHECK_IMAGE (padrão a imagem do `mobile-check`).
// Sai com código 1 se alguma conferência falhar. Ver revalle/docs/testes.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';

import {
  assertNoPaidGeminiCalls,
  BASE_URL,
  chooseInvoice,
  createConfirmedAccount,
  createEnvelope,
  db,
  distribute,
  hasPlaywrightImage,
  PLAYWRIGHT_IMAGE,
  runBrowserScript,
  signIn,
  trpcAs,
} from './tests/helpers.mjs';

const REQUIRED = [
  'REVSIGN_API_TOKEN',
  'REVSIGN_USER_EMAIL',
  'REVSIGN_USER_PASSWORD',
  'REVSIGN_ADMIN_EMAIL',
  'REVSIGN_ADMIN_PASSWORD',
];
const missing = REQUIRED.filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.error(`Defina ${missing.join(', ')}. Ver revalle/docs/testes.md.`);
  process.exit(2);
}

if (!hasPlaywrightImage()) {
  console.error(`Imagem ${PLAYWRIGHT_IMAGE} ausente no Docker: docker pull ${PLAYWRIGHT_IMAGE}`);
  process.exit(2);
}

// A NF pede sugestão: com uma chave real apontando para o Google, isso seria pago.
assertNoPaidGeminiCalls();

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const outDir = path.resolve(process.argv[2] ?? path.join(tmpdir(), 'revsign-ui-check-f7'));

mkdirSync(outDir, { recursive: true });

const invoiceFixture = async (variant) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  const lines = [
    'DANFE - Documento Auxiliar da Nota Fiscal Eletronica',
    'Chave de Acesso',
    '2924 1012 3456 7800 0195 5500 1000 0123 4511 2345 6784',
    'Emitente: Distribuidora Ficticia Ltda   CNPJ 12.345.678/0001-95',
    `Referencia: conferencia de tela ${variant} ${RUN}`,
    'Valor Total da Nota: R$ 150,00',
  ];

  for (const [index, line] of lines.entries()) {
    page.drawText(line, { x: 40, y: 800 - index * 16, size: 10, font });
  }

  const file = path.join(outDir, `nf-${variant}.pdf`);

  writeFileSync(file, await doc.save());

  return file;
};

const newInvoice = async (variant) => {
  const created = await createEnvelope({
    title: `[TESTE NF] Tela ${variant} ${RUN}`,
    pdf: await invoiceFixture(variant),
    meta: { distributionMethod: 'EMAIL' },
    recipients: [{ email: `tela-${variant}-${RUN}@revalle.com.br`, name: 'Teste' }],
  });

  if (created.status !== 200) {
    throw new Error(`criar a nota fiscal ${variant}: HTTP ${created.status} ${created.text}`);
  }

  return created.id;
};

const adminCookie = await signIn(process.env.REVSIGN_ADMIN_EMAIL, process.env.REVSIGN_ADMIN_PASSWORD);
const senderCookie = await signIn(process.env.REVSIGN_USER_EMAIL, process.env.REVSIGN_USER_PASSWORD);

if (!db(`select code from "RevalleAccountingAccount" where active limit 1`)) {
  throw new Error('nenhuma conta contábil ativa: importe a lista (Admin → Contas contábeis) ou rode a suíte antes');
}

const accountCode = db(`select code from "RevalleAccountingAccount" where active order by code limit 1`);
const accountant = await createConfirmedAccount({
  email: `tela-contabilidade-${RUN}@revalle.com.br`,
  name: 'Tela Contabilidade',
  password: `Tela-${RUN}-Senha!9`,
});

const setAccountant = async (isMember) => {
  const res = await trpcAs(adminCookie, 'mutation', 'revalle.accounting.adminSetMember', {
    userId: accountant.id,
    isMember,
  });

  if (res.status !== 200) {
    throw new Error(`marcar a Contabilidade: HTTP ${res.status} ${res.text}`);
  }
};

await setAccountant(true);

let status = 1;

try {
  const drafts = { 390: await newInvoice('390'), 1280: await newInvoice('1280') };
  const sentId = await newInvoice('enviada');
  const chosen = await chooseInvoice({ cookie: senderCookie, envelopeId: sentId, code: accountCode });

  if (chosen.status !== 200) {
    throw new Error(`escolher a conta e o centro: HTTP ${chosen.status} ${chosen.text}`);
  }

  await distribute(sentId);

  const counts = await trpcAs(accountant.cookie, 'query', 'revalle.invoice.pendingCounts');

  if (counts.status !== 200) {
    throw new Error(`contador da Contabilidade: HTTP ${counts.status} ${counts.text}`);
  }

  const result = await runBrowserScript({
    script: 'ui-check-f7.browser.mjs',
    payload: {
      baseUrl: BASE_URL,
      teamUrl: db(`select t.url from "Team" t join "Envelope" e on e."teamId" = t.id where e.id = '${sentId}'`),
      senderCookie,
      accountantCookie: accountant.cookie,
      drafts,
      sentId,
      pending: counts.body.result.data.json.accounting,
    },
    shotDir: outDir,
    timeout: 480_000,
  });

  console.log(result.stdout);
  console.error(result.stderr);
  status = result.status ?? 1;
} finally {
  await setAccountant(false);
}

console.log(`Prints em ${outDir}`);

if (status !== 0) {
  process.exit(1);
}

console.log('ui-check-f7: tudo verde');
