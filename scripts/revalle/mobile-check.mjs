#!/usr/bin/env node
// REVALLE: conferência do caminho de quem assina num celular de 360 px (viewport 360×740, escala 2).
//
// Passa por um fluxo real: cria e envia um documento pela API, abre o link de assinatura, passa pelo portão
// (termo, CPF/data de nascimento do Fernando fictício do dev-seed.sql, "sou eu"), assina um campo de assinatura e
// um de texto, abre e fecha os diálogos "Baixar PDF" e "Recusar" do menu de ações (e confere que, depois de cada um, o
// 1º toque num campo abre o campo), pede o código por e-mail (lido no Mailpit) e conclui.
// Antes, se houver sessão do remetente (REVSIGN_USER_EMAIL/REVSIGN_USER_PASSWORD, dono do token), confere o envio de
// uma nota fiscal fictícia no celular: o diálogo de envio com o bloco "Nota fiscal · Conta contábil", a escolha
// "Deixar para o Financeiro", o envio retido (aviso "Enviado para o Financeiro…" e o bloco só de leitura ao reabrir) e
// o cartão "Conta contábil" (só leitura, "Aguardando aprovação do Financeiro") de uma NF enviada com conta. Nesses passos a
// conferência vale só para o bloco/cartão: o editor do upstream não é feito para celular (a 360 px a página passa da
// largura da tela e as abas "E-mail"/"Nenhum" do diálogo têm 32 px). Depois abre a página "Notas fiscais": botões da
// página com 44 px e nenhuma rolagem horizontal da página inteira (a tabela rola dentro do próprio quadro).
// Depois: NF escaneada no diálogo de envio ("Responda para enviar" e o botão de enviar bloqueado até "Sim"/"Não"),
// NF v1 no editor antigo (o bloco da NF no topo), o link discreto "Marcar como nota fiscal" num documento comum já
// enviado (o cartão só aparece depois de marcar) e o cartão com a pergunta numa NF escaneada enviada sem resposta.
// Fase 6: quem assina essa NF enviada (portão com a Maria fictícia) vê, no celular, o bloco "Nota fiscal · Conta
// contábil: {código} – {nome}" acima do documento.
// Em cada passo tira um print e confere:
//   - sem rolagem horizontal (document.scrollingElement.scrollWidth <= 360);
//   - todo botão visível (button / role=button) com altura >= 44 px;
//   - nenhum elemento cortado para fora da tela à direita.
//
// O WSL não abre o Chromium; o navegador roda na imagem Docker do Playwright (mesma versão do pacote do repo).
// Uso (na raiz do repo, com a stack local no ar e as dependências instaladas):
//   REVSIGN_API_TOKEN=api_... node scripts/revalle/mobile-check.mjs [pasta-dos-prints]
// Variáveis: REVSIGN_URL (padrão http://localhost:3000), MOBILE_CHECK_IMAGE (padrão a imagem abaixo).
// Sai com código 1 se alguma conferência falhar. O resumo fica em <pasta>/report.json.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IMAGE = process.env.MOBILE_CHECK_IMAGE ?? 'mcr.microsoft.com/playwright:v1.56.1-noble';
const WIDTH = 360;
const HEIGHT = 740;
const MIN_TARGET = 44;
const FERNANDO = { cpf: '93457210888', birthDate: '31/12/1999' };
// Quem assina a NF do passo da conta (Fase 6): outra pessoa fictícia, para não mexer no vínculo do Fernando.
const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
// Campos do documento de teste (em % da página 1) e o centro de cada um, para o toque no canvas.
const FIELD_BOXES = {
  signature: { type: 'SIGNATURE', page: 1, positionX: 10, positionY: 70, width: 35, height: 8 },
  text: { type: 'TEXT', page: 1, positionX: 55, positionY: 70, width: 35, height: 6 },
};
const FIELDS = Object.fromEntries(
  Object.entries(FIELD_BOXES).map(([key, f]) => [
    key,
    { x: (f.positionX + f.width / 2) / 100, y: (f.positionY + f.height / 2) / 100 },
  ]),
);

// ---------------------------------------------------------------------------------------------------------------
// Parte 1 (no host): prepara o documento e chama o navegador no container.
// ---------------------------------------------------------------------------------------------------------------
const runHost = async () => {
  if (!process.env.REVSIGN_API_TOKEN) {
    console.error('Defina REVSIGN_API_TOKEN (token de API do time). Ver revalle/docs/testes.md.');
    process.exit(2);
  }

  const outDir = path.resolve(process.argv[2] ?? path.join(tmpdir(), 'revsign-mobile-check'));
  const { BASE_URL, createEnvelope, db, distribute } = await import('./tests/helpers.mjs');

  mkdirSync(outDir, { recursive: true });

  // O vínculo e-mail ↔ CPF é permanente: solta o do Fernando fictício para o portão pedir identidade de novo.
  db('delete from "RateLimit"');
  db(`delete from "RevalleEmailLink" where cpf = '${FERNANDO.cpf}'`);

  const email = `celular-${Date.now()}@revalle.com.br`;
  const created = await createEnvelope({
    title: `[TESTE] Celular ${new Date().toISOString()}`,
    recipients: [
      {
        email,
        name: 'Fernando Ensaio Barbosa',
        fields: Object.values(FIELD_BOXES),
      },
    ],
  });

  if (created.status !== 200) {
    throw new Error(`criar documento: HTTP ${created.status} ${created.text}`);
  }

  const [recipient] = await distribute(created.id);
  const signUrl = `${BASE_URL}/sign/${recipient.token}`;

  console.log(`- documento ${created.id} enviado para ${email}`);

  // A sessão vai para o container pelo ambiente (`-e NOME` sem valor): não aparece na linha de comando.
  const senderEnv = {};

  if (process.env.REVSIGN_USER_EMAIL && process.env.REVSIGN_USER_PASSWORD) {
    const { assertNoPaidGeminiCalls, signIn } = await import('./tests/helpers.mjs');

    // Os passos de NF pedem sugestão: com uma chave real apontando para o Google, isso seria pago.
    assertNoPaidGeminiCalls();

    const nf = await createEnvelope({
      title: `[TESTE NF] Celular ${new Date().toISOString()}`,
      pdf: await writeInvoiceFixture(outDir),
      recipients: [{ email: `celular-nf-${Date.now()}@revalle.com.br`, name: 'Teste' }],
    });

    if (nf.status !== 200) {
      throw new Error(`criar nota fiscal: HTTP ${nf.status} ${nf.text}`);
    }

    const teamUrl = db(`select t.url from "Team" t join "Envelope" e on e."teamId" = t.id where e.id = '${nf.id}'`);

    senderEnv.SENDER_COOKIE = await signIn(process.env.REVSIGN_USER_EMAIL, process.env.REVSIGN_USER_PASSWORD);
    senderEnv.EDITOR_URL = `${BASE_URL}/t/${teamUrl}/documents/${nf.id}/edit`;
    console.log(`- nota fiscal ${nf.id} (rascunho) para o passo do remetente`);

    // NF enviada com conta (escolhida pelo remetente): o cartão da página do documento, só leitura.
    const { trpcAs } = await import('./tests/helpers.mjs');
    const accountCode = db(`select code from "RevalleAccountingAccount" where active order by code limit 1`);

    if (!accountCode) {
      throw new Error('nenhuma conta contábil ativa: importe a lista (Admin → Contas contábeis) ou rode a suíte antes');
    }

    const sentNf = await createEnvelope({
      title: `[TESTE NF] Celular enviada ${new Date().toISOString()}`,
      pdf: await writeInvoiceFixture(outDir),
      recipients: [{ email: `celular-nf-env-${Date.now()}@revalle.com.br`, name: 'Teste' }],
    });

    if (sentNf.status !== 200) {
      throw new Error(`criar nota enviada: HTTP ${sentNf.status} ${sentNf.text}`);
    }

    const chosen = await trpcAs(senderEnv.SENDER_COOKIE, 'mutation', 'revalle.invoice.setChoice', {
      envelopeId: sentNf.id,
      choice: { code: accountCode },
    });

    if (chosen.status !== 200) {
      throw new Error(`escolher a conta da nota enviada: HTTP ${chosen.status} ${chosen.text}`);
    }

    const [nfSigner] = await distribute(sentNf.id);

    senderEnv.SENT_INVOICE_URL = `${BASE_URL}/t/${teamUrl}/documents/${sentNf.id}`;
    // Fase 6: a mesma NF aberta por quem assina mostra a conta escolhida.
    senderEnv.NF_SIGN_URL = `${BASE_URL}/sign/${nfSigner.token}`;
    senderEnv.NF_ACCOUNT_CODE = accountCode;
    db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);

    // NF escaneada (só imagem: "É nota fiscal?"): "Enviar" bloqueado até a resposta.
    const scanned = await createEnvelope({
      title: `[TESTE NF] Celular escaneada ${new Date().toISOString()}`,
      pdf: await writeScannedFixture(outDir),
      recipients: [{ email: `celular-nf-esc-${Date.now()}@revalle.com.br`, name: 'Teste' }],
    });

    if (scanned.status !== 200) {
      throw new Error(`criar nota escaneada: HTTP ${scanned.status} ${scanned.text}`);
    }

    senderEnv.SCANNED_EDITOR_URL = `${BASE_URL}/t/${teamUrl}/documents/${scanned.id}/edit`;

    // NF v1 (abre no editor antigo, que também tem o bloco da NF).
    const form = new FormData();

    form.append(
      'payload',
      JSON.stringify({
        title: `[TESTE NF] Celular v1 ${new Date().toISOString()}`,
        meta: { distributionMethod: 'NONE' },
        recipients: [{ email: `celular-nf-v1-${Date.now()}@revalle.com.br`, name: 'Teste', role: 'SIGNER' }],
      }),
    );
    form.append(
      'file',
      new File([readFileSync(await writeInvoiceFixture(outDir))], 'nf-v1.pdf', { type: 'application/pdf' }),
    );

    const v1 = await fetch(`${BASE_URL}/api/v2-beta/document/create`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.REVSIGN_API_TOKEN}` },
      body: form,
    });
    const v1Body = await v1.json();

    if (v1.status !== 200) {
      throw new Error(`criar nota v1: HTTP ${v1.status} ${JSON.stringify(v1Body)}`);
    }

    senderEnv.LEGACY_EDITOR_URL = `${BASE_URL}/t/${teamUrl}/documents/${v1Body.envelopeId}/legacy_editor`;

    // Documento comum já enviado: o cartão "Conta contábil" oferece "Marcar como nota fiscal".
    const common = await createEnvelope({
      title: `[TESTE] Celular marcar NF ${new Date().toISOString()}`,
      recipients: [{ email: `celular-marcar-${Date.now()}@revalle.com.br`, name: 'Teste' }],
    });

    if (common.status !== 200) {
      throw new Error(`criar documento comum: HTTP ${common.status} ${common.text}`);
    }

    await distribute(common.id);
    senderEnv.SENT_DOC_URL = `${BASE_URL}/t/${teamUrl}/documents/${common.id}`;

    // NF escaneada enviada pela API sem resposta: fica UNKNOWN (o servidor não exige a resposta).
    const sentScanned = await createEnvelope({
      title: `[TESTE NF] Celular escaneada enviada ${new Date().toISOString()}`,
      pdf: await writeScannedFixture(outDir),
      recipients: [{ email: `celular-nf-esc-env-${Date.now()}@revalle.com.br`, name: 'Teste' }],
    });

    if (sentScanned.status !== 200) {
      throw new Error(`criar nota escaneada enviada: HTTP ${sentScanned.status} ${sentScanned.text}`);
    }

    await distribute(sentScanned.id);
    senderEnv.SENT_SCANNED_URL = `${BASE_URL}/t/${teamUrl}/documents/${sentScanned.id}`;
  } else {
    console.log('- sem REVSIGN_USER_EMAIL/REVSIGN_USER_PASSWORD: passo da nota fiscal pulado');
  }

  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'host',
      '--ipc',
      'host',
      '-u',
      `${process.getuid()}:${process.getgid()}`,
      '-e',
      'HOME=/tmp',
      '-e',
      'MOBILE_CHECK_STAGE=browser',

      '-e',
      `SIGN_URL=${signUrl}`,
      '-e',
      `SIGNER_EMAIL=${email}`,
      '-e',
      `SIGNER_CPF=${FERNANDO.cpf}`,
      '-e',
      `SIGNER_BIRTH_DATE=${FERNANDO.birthDate}`,
      '-e',
      `NF_SIGNER_CPF=${MARIA.cpf}`,
      '-e',
      `NF_SIGNER_BIRTH_DATE=${MARIA.birthDate}`,
      ...Object.keys(senderEnv).flatMap((name) => ['-e', name]),
      '-v',
      `${ROOT}:/repo:ro`,
      '-v',
      `${outDir}:/out`,
      '-w',
      '/repo',
      IMAGE,
      'node',
      'scripts/revalle/mobile-check.mjs',
    ],
    { stdio: 'inherit', env: { ...process.env, ...senderEnv } },
  );

  db(`delete from "RevalleEmailLink" where cpf = '${FERNANDO.cpf}'`);
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);

  process.exit(result.status ?? 1);
};

// "NF escaneada": só uma imagem (o desenho dos testes), nenhum texto.
const writeScannedFixture = async (dir) => {
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const { drawingPng } = await import('./tests/helpers.mjs');
  const doc = await PDFDocument.create();
  const png = await doc.embedPng(Buffer.from(drawingPng().split(',')[1], 'base64'));
  const page = doc.addPage([595, 842]);

  page.drawImage(png, { x: 40, y: 500, width: 500, height: 170 });
  doc.setTitle(`NF digitalizada celular ${Date.now()}`);

  const file = path.join(dir, 'nf-escaneada-celular.pdf');

  writeFileSync(file, await doc.save());

  return file;
};

// DANFE fictício (chave de acesso fictícia com DV válido), para o passo do remetente.
const writeInvoiceFixture = async (dir) => {
  const { PDFDocument, StandardFonts } = await import('@cantoo/pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  const lines = [
    'DANFE - Documento Auxiliar da Nota Fiscal Eletronica',
    'Chave de Acesso',
    '2924 1012 3456 7800 0195 5500 1000 0123 4511 2345 6784',
    'Emitente: Distribuidora Ficticia Ltda   CNPJ 12.345.678/0001-95',
    `Referencia: celular ${Date.now()}`,
    'Valor Total da Nota: R$ 150,00',
  ];

  for (const [index, line] of lines.entries()) {
    page.drawText(line, { x: 40, y: 800 - index * 16, size: 10, font });
  }

  const file = path.join(dir, 'nf-celular.pdf');

  writeFileSync(file, await doc.save());

  return file;
};

// ---------------------------------------------------------------------------------------------------------------
// Parte 2 (no container): navegador.
// ---------------------------------------------------------------------------------------------------------------

// Roda dentro da página: devolve os problemas de layout do estado atual.
// `scope` (seletor): confere só dentro desse elemento (diálogo/cartão), inclusive a rolagem horizontal dele.
const inspectLayout = ({ minTarget, scope, pageScroll = false }) => {
  const vw = window.innerWidth;
  const problems = [];
  const root = scope ? document.querySelector(scope) : document.body;

  if (!root) {
    return { scrollWidth: null, problems: [{ kind: 'missing-scope', detail: scope }] };
  }

  const describe = (el) => {
    const label = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 60);
    const cls = typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 6).join('.') : '';

    return `<${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}> "${label}"`;
  };
  const isShown = (el) => {
    const rect = el.getBoundingClientRect();

    if (rect.width <= 1 || rect.height <= 1) {
      return false; // display:none ou sr-only
    }

    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);

      if (style.visibility === 'hidden' || style.opacity === '0' || node.getAttribute('aria-hidden') === 'true') {
        return false;
      }
    }

    return true;
  };

  const scrollWidth = scope ? root.scrollWidth : document.scrollingElement.scrollWidth;
  const maxWidth = scope ? Math.min(root.clientWidth, vw) : vw;

  if (scrollWidth > maxWidth + (scope ? 1 : 0)) {
    problems.push({ kind: 'horizontal-scroll', detail: `scrollWidth ${scrollWidth} > ${maxWidth}` });
  }

  // `pageScroll`: com escopo, confere também a rolagem horizontal da página inteira.
  if (scope && pageScroll && document.scrollingElement.scrollWidth > vw) {
    problems.push({
      kind: 'page-horizontal-scroll',
      detail: `scrollWidth ${document.scrollingElement.scrollWidth} > ${vw}`,
    });
  }

  // Botões: altura mínima de toque. Caixa de seleção/rádio/switch valem pela área do <label> que os envolve.
  for (const el of root.querySelectorAll('button, [role="button"]')) {
    if (!isShown(el)) {
      continue;
    }

    const role = el.getAttribute('role');
    let target = el;

    if (role && role !== 'button' && ['checkbox', 'radio', 'switch'].includes(role)) {
      target = el.closest('label') ?? (el.id ? document.querySelector(`label[for="${el.id}"]`) : null) ?? el;
    }

    const height = Math.round(target.getBoundingClientRect().height * 10) / 10;

    if (height < minTarget) {
      problems.push({ kind: 'small-target', detail: `${describe(el)} altura ${height}px` });
    }
  }

  // Cortado à direita: passa da largura da tela sem um contêiner (que não seja html/body) que o recorte de propósito.
  const offenders = new Set();

  for (const el of root.querySelectorAll('*')) {
    if (!isShown(el)) {
      continue;
    }

    const rect = el.getBoundingClientRect();

    if (rect.right <= vw + 1 || rect.left >= vw) {
      continue;
    }

    let clippedByAncestor = false;

    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);

      if (style.overflowX !== 'visible' && node.getBoundingClientRect().right <= vw + 1) {
        clippedByAncestor = true;
        break;
      }
    }

    if (!clippedByAncestor && !(el.parentElement && offenders.has(el.parentElement))) {
      offenders.add(el);
      problems.push({ kind: 'clipped-right', detail: `${describe(el)} right ${Math.round(rect.right)}px` });
    }
  }

  return { scrollWidth, problems };
};

const runBrowser = async () => {
  const { chromium } = await import('playwright');
  const { getLatestCode } = await import('./tests/helpers.mjs');
  const { SIGN_URL, SIGNER_EMAIL, SIGNER_CPF, SIGNER_BIRTH_DATE } = process.env;
  const out = '/out';
  const steps = [];

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'pt-BR',
    permissions: [],
  });
  const page = await context.newPage();

  page.setDefaultTimeout(30_000);

  // Os campos são desenhados num canvas (Konva): o toque vai na posição do campo, em % da página 1.
  const clickField = async ({ x, y }) => {
    const pageCanvas = page.locator('.konva-container').first();

    await pageCanvas.evaluate((el, fy) => {
      const rect = el.getBoundingClientRect();

      el.closest('.embed--DocumentContainer')?.scrollBy(0, rect.top + rect.height * fy - window.innerHeight / 3);
    }, y);
    await page.waitForTimeout(300);

    const box = await pageCanvas.boundingBox();

    await page.touchscreen.tap(box.x + box.width * x, box.y + box.height * y);
  };

  const check = async (name, onPage = page, scope = undefined, { pageScroll = false } = {}) => {
    await onPage.waitForTimeout(600); // animações dos diálogos
    await onPage.screenshot({ path: `${out}/${name}.png` });

    const { scrollWidth, problems } = await onPage.evaluate(inspectLayout, {
      minTarget: MIN_TARGET,
      scope,
      pageScroll,
    });

    steps.push({ step: name, scrollWidth, problems });
    console.log(`${problems.length === 0 ? 'ok  ' : 'FALHA'} ${name} (scrollWidth ${scrollWidth})`);

    for (const p of problems) {
      console.log(`      ${p.kind}: ${p.detail}`);
    }
  };

  // 0. Remetente: envio de uma nota fiscal (opcional, com a sessão vinda do host).
  if (process.env.SENDER_COOKIE && process.env.EDITOR_URL) {
    const senderContext = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      locale: 'pt-BR',
    });
    const sender = await senderContext.newPage();
    const editorUrl = new URL(process.env.EDITOR_URL);

    sender.setDefaultTimeout(30_000);
    await senderContext.addCookies(
      process.env.SENDER_COOKIE.split('; ').map((pair) => {
        const index = pair.indexOf('=');

        return { name: pair.slice(0, index), value: pair.slice(index + 1), url: editorUrl.origin };
      }),
    );

    try {
      await sender.goto(editorUrl.href, { waitUntil: 'networkidle' });
      await sender
        .getByRole('button', { name: /enviar documento/i })
        .filter({ visible: true })
        .first()
        .click();

      const panel = sender.getByTestId('invoice-account-panel');

      await panel.waitFor();
      // Espera a sugestão terminar (ou a tela desistir, em 30 s).
      await panel.getByText('Buscando sugestão…').waitFor({ state: 'detached', timeout: 40_000 });
      await check('00a-nf-envio', sender, '[data-testid="invoice-account-panel"]');

      await panel.getByRole('button', { name: 'Deixar para o Financeiro' }).click();
      await panel.getByText('Escolha: deixar para o Financeiro').waitFor();
      await check('00b-nf-escolhida', sender, '[data-testid="invoice-account-panel"]');

      // Envio retido: o aviso de sucesso e a volta para a lista; o documento continua rascunho.
      await sender
        .getByRole('dialog')
        .getByRole('button', { name: /^(enviar|gerar links)$/i })
        .click();
      // O toast também é lido num aviso para leitor de tela (aria-live): o texto exato pega só o toast visível.
      await sender
        .getByText('Enviado para o Financeiro definir a conta. Os convites saem depois disso.', { exact: true })
        .waitFor();
      await sender.waitForURL(/\/documents\/?(\?.*)?$/, { timeout: 60_000 });

      // Reaberto: o bloco só mostra o estado, sem escolha, e o botão de enviar fica bloqueado.
      await sender.goto(editorUrl.href, { waitUntil: 'networkidle' });
      await sender
        .getByRole('button', { name: /enviar documento/i })
        .filter({ visible: true })
        .first()
        .click();
      await panel.getByText('Aguardando o Financeiro definir a conta').waitFor();

      if ((await panel.getByRole('button').count()) > 0) {
        throw new Error('NF retida: o bloco não deveria ter botões');
      }

      if (
        !(await sender
          .getByRole('dialog')
          .getByRole('button', { name: /^(enviar|gerar links)$/i })
          .isDisabled())
      ) {
        throw new Error('NF retida: o botão de enviar deveria estar bloqueado');
      }

      await check('00b2-nf-retida', sender, '[data-testid="invoice-account-panel"]');

      // NF enviada com conta: o cartão só mostra a conta e o estado no Financeiro.
      await sender.goto(process.env.SENT_INVOICE_URL, { waitUntil: 'networkidle' });

      const sentCard = sender.getByTestId('invoice-account-card');

      await sentCard.getByText('Aguardando aprovação do Financeiro').waitFor();

      if ((await sentCard.getByRole('button').count()) > 0) {
        throw new Error('NF enviada: o cartão do remetente não deveria ter botões');
      }

      await sentCard.scrollIntoViewIfNeeded();
      await check('00c-nf-cartao', sender, '[data-testid="invoice-account-card"]');

      // Página "Notas fiscais": a tabela rola dentro do quadro, nunca a página. Os toques valem dentro da página (os
      // ícones de busca e menu do cabeçalho do upstream têm 24 px).
      await sender.goto(`${editorUrl.origin}/notas-fiscais`, { waitUntil: 'networkidle' });
      await sender.getByTestId('invoices-page').locator('tbody tr').first().waitFor();
      await check('00d-notas-fiscais', sender, '[data-testid="invoices-page"]', { pageScroll: true });

      // NF escaneada: "Este documento é uma nota fiscal?" com "Responda para enviar" e o botão de enviar bloqueado até
      // a resposta; "Não" libera.
      await sender.goto(process.env.SCANNED_EDITOR_URL, { waitUntil: 'networkidle' });
      await sender
        .getByRole('button', { name: /enviar documento/i })
        .filter({ visible: true })
        .first()
        .click();

      const question = sender.getByTestId('invoice-question');
      const sendButton = sender.getByRole('dialog').getByRole('button', { name: /^(enviar|gerar links)$/i });

      await question.getByText('Responda para enviar').waitFor();

      if (!(await sendButton.isDisabled())) {
        throw new Error('NF escaneada sem resposta: o botão de enviar deveria estar bloqueado');
      }

      await check('00e-nf-escaneada', sender, '[data-testid="invoice-question"]');
      // A 360 px o editor do upstream passa da largura da tela e o diálogo fica deslocado: o "Não" fica fora da tela
      // (limite já conhecido do editor, ver o topo do arquivo). O clique vai pelo DOM; a conferência vale para o bloco.
      await question.getByRole('button', { name: 'Não', exact: true }).evaluate((button) => button.click());
      await question.waitFor({ state: 'detached' });
      await sender.waitForFunction(
        () =>
          [...document.querySelectorAll('[role="dialog"] button[type="submit"]')].some((button) => !button.disabled),
        undefined,
        { timeout: 10_000 },
      );

      // Documento v1: o editor antigo mostra o bloco da NF no topo.
      await sender.goto(process.env.LEGACY_EDITOR_URL, { waitUntil: 'networkidle' });
      await sender.getByTestId('invoice-account-panel').waitFor();
      await check('00f-nf-editor-antigo', sender, '[data-testid="invoice-account-panel"]');

      // Documento comum já enviado: sem o cartão, só o link discreto "É uma nota fiscal? Marcar como nota fiscal"
      // (44 px de toque); marcar abre o cartão com a escolha da conta.
      await sender.goto(process.env.SENT_DOC_URL, { waitUntil: 'networkidle' });

      const markLink = sender.getByTestId('invoice-mark-link');

      await markLink.waitFor();

      if ((await sender.getByTestId('invoice-account-card').count()) > 0) {
        throw new Error('documento comum: o cartão "Conta contábil" não deveria aparecer antes de marcar');
      }

      await markLink.scrollIntoViewIfNeeded();
      await check('00g-nf-link-marcar', sender, '[data-testid="invoice-mark-link"]');
      await markLink.getByRole('button', { name: 'Marcar como nota fiscal' }).click();

      const card = sender.getByTestId('invoice-account-card');

      await card.getByText('Nenhuma conta escolhida.').waitFor();
      await card.scrollIntoViewIfNeeded();
      await check('00h-nf-marcada', sender, '[data-testid="invoice-account-card"]');

      // NF escaneada enviada sem resposta (UNKNOWN, pela API): o cartão inteiro, com a pergunta.
      await sender.goto(process.env.SENT_SCANNED_URL, { waitUntil: 'networkidle' });

      const unknownCard = sender.getByTestId('invoice-account-card');

      await unknownCard.getByText('Este documento é uma nota fiscal?').waitFor();
      await unknownCard.scrollIntoViewIfNeeded();
      await check('00i-nf-escaneada-enviada', sender, '[data-testid="invoice-account-card"]');
    } catch (error) {
      await sender.screenshot({ path: `${out}/erro-nf.png` }).catch(() => {});
      steps.push({ step: 'nf', scrollWidth: null, problems: [{ kind: 'flow-error', detail: String(error) }] });
      console.log(`FALHA no passo da nota fiscal: ${error}`);
    } finally {
      await senderContext.close();
    }
  }

  // 0b. Fase 6: quem assina a NF vê a conta contábil acima do documento, também no celular.
  if (process.env.NF_SIGN_URL) {
    const nfContext = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      locale: 'pt-BR',
    });
    const nfPage = await nfContext.newPage();

    nfPage.setDefaultTimeout(30_000);

    try {
      await nfPage.goto(process.env.NF_SIGN_URL, { waitUntil: 'networkidle' });
      await nfPage.getByText('Antes de assinar').waitFor();
      await nfPage.locator('label[for="revalle-term-accept"]').click();
      await nfPage.getByRole('button', { name: 'Continuar' }).click();
      await nfPage.getByText('Confirme que é você').waitFor();
      await nfPage.getByLabel('CPF').fill(process.env.NF_SIGNER_CPF);
      await nfPage.getByLabel('Data de nascimento').fill(process.env.NF_SIGNER_BIRTH_DATE);
      await nfPage.getByRole('button', { name: 'Confirmar', exact: true }).click();
      await nfPage.getByRole('button', { name: 'Sim, sou eu' }).click();
      await nfPage.locator('.konva-container canvas').first().waitFor({ timeout: 60_000 });
      await nfPage.waitForLoadState('networkidle');

      const block = nfPage.getByTestId('invoice-signing-account');

      await block.waitFor();

      const text = (await block.innerText()).replace(/\s+/g, ' ');

      if (!text.startsWith(`Nota fiscal · Conta contábil: ${process.env.NF_ACCOUNT_CODE} – `)) {
        throw new Error(`bloco da conta com texto inesperado: "${text}"`);
      }

      const box = await block.boundingBox();

      if (!box || box.y + box.height > HEIGHT) {
        throw new Error('o bloco da conta não aparece na primeira tela do celular');
      }

      await check('00j-nf-conta-ao-assinar', nfPage);
    } catch (error) {
      await nfPage.screenshot({ path: `${out}/erro-nf-assinatura.png` }).catch(() => {});
      steps.push({
        step: 'nf-assinatura',
        scrollWidth: null,
        problems: [{ kind: 'flow-error', detail: String(error) }],
      });
      console.log(`FALHA no passo da conta ao assinar: ${error}`);
    } finally {
      await nfContext.close();
    }
  }

  try {
    // 1. Portão: termo.
    await page.goto(SIGN_URL, { waitUntil: 'networkidle' });
    await page.getByText('Antes de assinar').waitFor();
    await check('01-termo');
    await page.locator('label[for="revalle-term-accept"]').click();
    await page.getByRole('button', { name: 'Continuar' }).click();

    // 2. Portão: identidade.
    await page.getByText('Confirme que é você').waitFor();
    await check('02-identidade');
    await page.getByLabel('CPF').fill(SIGNER_CPF);
    await page.getByLabel('Data de nascimento').fill(SIGNER_BIRTH_DATE);
    await page.getByRole('button', { name: 'Confirmar', exact: true }).click();

    // 3. Portão: "sou eu".
    await page.getByRole('button', { name: 'Sim, sou eu' }).waitFor();
    await check('03-sou-eu');
    await page.getByRole('button', { name: 'Sim, sou eu' }).click();

    // 4. Documento.
    await page.locator('.konva-container canvas').first().waitFor({ timeout: 60_000 });
    await page.waitForLoadState('networkidle');
    await check('04-documento');

    // 5. Menu de ações: "Baixar PDF" (abre e fecha) e "Recusar" (abre e cancela). Os dois diálogos abrem de dentro do
    // menu; depois de fechar cada um, o 1º toque num campo tem de abrir o campo. Com o menu modal do upstream, o menu
    // continuava aberto e invisível (body com pointer-events: none) e esse toque se perdia.
    const openActionsItem = async (pattern) => {
      await page.locator('nav').getByRole('button').last().click();
      await page.getByRole('menuitem').filter({ hasText: pattern }).waitFor();
    };

    const firstTapOpens = async (step, field) => {
      await clickField(field);

      const isOpened = await page
        .getByRole('dialog')
        .waitFor({ timeout: 5000 })
        .then(
          () => true,
          () => false,
        );

      if (!isOpened) {
        const detail = 'depois de fechar o diálogo, o 1º toque no campo não o abriu';

        steps.push({ step, scrollWidth: null, problems: [{ kind: 'first-tap-lost', detail }] });
        console.log(`FALHA ${step}: ${detail}`);
        await clickField(field);
        await page.getByRole('dialog').waitFor();
      }
    };

    await openActionsItem(/baixar|download/i);
    await check('05-menu-acoes');
    await page
      .getByRole('menuitem')
      .filter({ hasText: /baixar|download/i })
      .click();
    await page.getByRole('dialog').waitFor();
    await check('06-baixar');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /fechar|close/i })
      .click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await check('07-baixar-fechado');
    await firstTapOpens('07-baixar-fechado', FIELDS.text);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /cancelar/i })
      .click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });

    await openActionsItem(/recus|rejeit|reject/i);
    await page
      .getByRole('menuitem')
      .filter({ hasText: /recus|rejeit|reject/i })
      .click();
    await page.getByRole('dialog').waitFor();
    await check('08-recusar');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /cancelar/i })
      .click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await firstTapOpens('08-recusar', FIELDS.signature);

    await check('09-dialogo-assinatura');

    const canvas = page.getByRole('dialog').locator('canvas').first();
    const box = await canvas.boundingBox();

    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.6);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.3, { steps: 8 });
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7, { steps: 8 });
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.4, { steps: 8 });
    await page.mouse.up();
    await page
      .getByRole('dialog')
      .getByRole('button')
      .filter({ hasText: /^(assinar|sign)$/i })
      .click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });

    // 7. Campo de texto.
    await clickField(FIELDS.text);
    await page.getByRole('dialog').waitFor();
    await check('10-dialogo-texto');
    await page.getByRole('dialog').locator('textarea, input').first().fill('Teste no celular');
    await page.getByRole('dialog').getByRole('button').last().click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await check('11-campos-preenchidos');

    // 8. Concluir: diálogo, código por e-mail e conclusão.
    const before = await getLatestCode(SIGNER_EMAIL);

    await page
      .getByRole('button', { name: /^(concluir|complete)$/i })
      .first()
      .click();
    await page.getByRole('dialog').waitFor();
    await check('12-dialogo-concluir');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^(assinar|sign)$/i })
      .click();
    await page.getByRole('button', { name: /enviar código/i }).waitFor();
    await check('13-pedir-codigo');
    await page.getByRole('button', { name: /enviar código/i }).click();

    let code;

    for (let i = 0; i < 40 && !code; i += 1) {
      const latest = await getLatestCode(SIGNER_EMAIL);

      code = latest && latest !== before ? latest : undefined;

      if (!code) {
        await page.waitForTimeout(500);
      }
    }

    if (!code) {
      throw new Error('o código não chegou ao Mailpit');
    }

    await page.locator('input[autocomplete="one-time-code"], [data-input-otp]').first().waitFor();
    await page.locator('input[autocomplete="one-time-code"], [data-input-otp]').first().fill(code);
    await check('14-codigo');
    await page.getByRole('button', { name: /confirmar e concluir/i }).click();

    // 9. Página de conclusão.
    await page.waitForURL(/\/complete/, { timeout: 60_000 });
    await page.waitForLoadState('networkidle');
    await check('15-concluido');
  } catch (error) {
    await page.screenshot({ path: `${out}/erro.png` }).catch(() => {});
    steps.push({ step: 'erro', scrollWidth: null, problems: [{ kind: 'flow-error', detail: String(error) }] });
    console.log(`FALHA no fluxo: ${error}`);
  } finally {
    await browser.close();
  }

  const failed = steps.filter((s) => s.problems.length > 0);

  writeFileSync(
    `${out}/report.json`,
    `${JSON.stringify({ viewport: `${WIDTH}x${HEIGHT}@2x`, ok: failed.length === 0, steps }, null, 2)}\n`,
  );
  console.log(
    failed.length === 0 ? 'mobile-check: tudo verde' : `mobile-check: ${failed.length} passo(s) com problema`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
};

if (process.env.MOBILE_CHECK_STAGE === 'browser') {
  await runBrowser();
} else {
  await runHost();
}
