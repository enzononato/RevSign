#!/usr/bin/env node
// REVALLE: prévia estática dos e-mails (HTML + texto puro) pelo mesmo caminho do envio real (`renderEmailWithI18N`,
// catálogo pt-BR). Sobe um Vite só em memória (sem porta) para os macros do Lingui e o `.po`, renderiza e grava em
// <saída>/<nome>.html e <nome>.txt. Uso:
//   node scripts/revalle/email-preview.mjs [pasta-de-saída]     (padrão: ./email-preview)
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'development'; // o i18n-server lê o `.po` (e não o `.mjs` compilado) em desenvolvimento

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = resolve(process.argv[2] ?? 'email-preview');

const { createServer } = await import('vite');
const { lingui } = await import('@lingui/vite-plugin');
const { default: macrosPlugin } = await import('vite-plugin-babel-macros');
const { default: tsconfigPaths } = await import('vite-tsconfig-paths');

const server = await createServer({
  root: ROOT,
  configFile: false,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, watch: null },
  appType: 'custom',
  esbuild: { jsx: 'automatic' },
  plugins: [macrosPlugin(), lingui(), tsconfigPaths()],
  ssr: {
    noExternal: ['@documenso/email'],
    external: ['@prisma/client', '@documenso/tailwind-config'],
  },
  optimizeDeps: { noDiscovery: true, include: [] },
});

const load = (path) => server.ssrLoadModule(join(ROOT, path));

try {
  const { createElement } = await import('react'); // o mesmo React que o Vite deixa externo no SSR
  const { renderEmailWithI18N } = await load('packages/lib/utils/render-email-with-i18n.tsx');
  const { DocumentInviteEmailTemplate } = await load('packages/email/templates/document-invite.tsx');
  const { DocumentReminderEmailTemplate } = await load('packages/email/templates/document-reminder.tsx');
  const { DocumentCompletedEmailTemplate } = await load('packages/email/templates/document-completed.tsx');
  const { AccessAuth2FAEmailTemplate } = await load('packages/email/templates/access-auth-2fa.tsx');

  const assetBaseUrl = 'https://assinaturas.revalle.com.br';
  const signDocumentLink = `${assetBaseUrl}/sign/QdA9pXv3sK2mT7wZr1bYc`;

  // Destinatário pessoa física, como no envio da Revalle (organização pessoal).
  const invite = {
    inviterName: 'Ana Souza',
    inviterEmail: 'ana.souza@revalle.com.br',
    documentName: 'Aditivo contratual 2026.pdf',
    signDocumentLink,
    assetBaseUrl,
    organisationType: 'PERSONAL',
    teamName: 'Equipe pessoal',
    includeSenderDetails: false,
  };

  const previews = {
    'convite-assinante-com-nome': [
      DocumentInviteEmailTemplate,
      { ...invite, role: 'SIGNER', recipientName: 'Carlos Pereira' },
    ],
    'convite-assinante-sem-nome': [DocumentInviteEmailTemplate, { ...invite, role: 'SIGNER', recipientName: '' }],
    'convite-aprovador': [
      DocumentInviteEmailTemplate,
      {
        ...invite,
        role: 'APPROVER',
        recipientName: 'Marina Lopes',
        customBody: 'Oi, Marina.\n\nPreciso da sua aprovação até sexta para fecharmos o mês.\nObrigada!',
      },
    ],
    'convite-contrato-remetente-fixo': [
      DocumentInviteEmailTemplate,
      {
        ...invite,
        role: 'SIGNER',
        recipientName: 'João da Silva',
        inviterName: 'RH Revalle',
        inviterEmail: 'admin@revalle.com.br',
        documentName: 'Contrato de trabalho - João da Silva',
        revalleHideInviterEmail: true,
      },
    ],
    'lembrete-assinante': [
      DocumentReminderEmailTemplate,
      {
        recipientName: 'Carlos Pereira',
        inviterName: invite.inviterName,
        documentName: invite.documentName,
        signDocumentLink,
        assetBaseUrl,
        role: 'SIGNER',
      },
    ],
    'documento-concluido': [
      DocumentCompletedEmailTemplate,
      {
        documentName: invite.documentName,
        assetBaseUrl,
        downloadLink: `${assetBaseUrl}/sign/QdA9pXv3sK2mT7wZr1bYc/complete`,
      },
    ],
    'codigo-de-acesso-2fa': [
      AccessAuth2FAEmailTemplate,
      {
        documentTitle: invite.documentName,
        code: '482913',
        userEmail: 'carlos.pereira@revalle.com.br',
        userName: 'Carlos Pereira',
        expiresInMinutes: 10,
        assetBaseUrl,
      },
    ],
  };

  await mkdir(OUT, { recursive: true });

  for (const [name, [Component, props]] of Object.entries(previews)) {
    const element = createElement(Component, props);

    const [html, text] = await Promise.all([
      renderEmailWithI18N(element, { lang: 'pt-BR' }),
      renderEmailWithI18N(element, { lang: 'pt-BR', plainText: true }),
    ]);

    await writeFile(join(OUT, `${name}.html`), html);
    await writeFile(join(OUT, `${name}.txt`), `${text}\n`);

    console.log(`${join(OUT, name)}.{html,txt}`);
  }
} finally {
  await server.close();
}
