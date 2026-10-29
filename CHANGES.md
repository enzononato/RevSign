# RevSign — alterações sobre o Documenso

Base: Documenso `v2.21.1` (`8707e33c`). Repositório: https://github.com/enzononato/RevSign

Este arquivo é o guia para trazer novas versões do upstream (`git fetch upstream --tags && git merge vX.Y.Z`).
Toda edição em arquivo do upstream é marcada com `REVALLE:` no código e listada abaixo.

## Arquivos do upstream alterados

| Arquivo | Mudança | Motivo | Fase |
|---|---|---|---|
| `.github/workflows/*.yml` (todos do upstream) e `.github/dependabot.yml` | Removidos | O RevSign não é fork, então o GitHub ativaria os workflows do upstream (`deploy.yml` roda em qualquer tag, `stale`/`translations-pull` são agendados, `publish.yml` publica em `documenso/*`). No merge de uma nova versão, conflito do tipo *modify/delete* nesses arquivos se resolve com `git rm` | 1 |
| `.gitignore` | Bloco `REVALLE:` no final | Impedir commit de `.env*`, certificados e chaves | 1 |
| `.husky/pre-commit` | Uma linha chamando `scripts/revalle/check-secrets.sh` | Bloqueio local de commit de segredos | 1 |
| `apps/remix/app/root.tsx` | Import + renderização de `<SourceCodeLink />` | AGPL §13: link "Código-fonte" em todas as telas | 1 |
| `packages/lib/utils/organisations.ts` | `generateDefaultOrganisationSettings`: pt-BR, `America/Bahia`, `dd/MM/yyyy HH:mm`, `includeAuditLog: true`; removido o import `DEFAULT_DOCUMENT_DATE_FORMAT`, que ficou sem uso | Toda organização nova (inclusive a pessoal de cada remetente) nasce com os padrões da Revalle | 1 |
| `packages/lib/server-only/rate-limit/rate-limit.ts` | Import + aplicação de `getRateLimitOverride` em `createRateLimit` | Limites de tentativas ajustáveis por `NEXT_PRIVATE_REVALLE_RATE_LIMITS`; padrão `auth.signup` de 3/3h para 30/1h por IP (cada unidade sai por um único IP) | 1 |
| `apps/remix/server/router.ts` | Import + chamada `void runRevalleBootstrap();` depois de `migrateLegacyServiceAccount()` | Na subida, plano `free` sem limites de equipes/membros/destinatários e com branding liberado (reaplicado a cada reinício: edições manuais desse claim em Admin → Claims são revertidas); promove a ADMIN a conta com e-mail confirmado de `NEXT_PRIVATE_REVALLE_ADMIN_EMAIL` | 1 |
| `packages/lib/server-only/envelope/create-envelope.ts` | Import + 1 chamada `assertRecipientEmailsAllowed(...)` após `requestedRecipients` | Só e-mails dos domínios da empresa (`NEXT_PRIVATE_ALLOWED_SIGNUP_DOMAINS`) viram destinatários | 3 |
| `packages/lib/server-only/recipient/create-envelope-recipients.ts` | Import + 1 chamada `assertRecipientEmailsAllowed(...)` após `assertEnvelopeMutable` | Mesma regra ao adicionar destinatários | 3 |
| `packages/lib/server-only/recipient/update-envelope-recipients.ts` | Import + 1 chamada `assertRecipientEmailsAllowed(...)` após `assertEnvelopeMutable` | Mesma regra ao alterar e-mails | 3 |
| `packages/lib/server-only/recipient/set-document-recipients.ts` | Import + 1 chamada `assertRecipientEmailsAllowed(...)` após `assertEnvelopeMutable` | Mesma regra no editor (setDocumentRecipients) | 3 |
| `packages/lib/server-only/template/create-document-from-template.ts` | Import + 1 chamada `assertRecipientEmailsAllowed(finalRecipients...)` | Mesma regra ao criar documento a partir de modelo (placeholders ignorados) | 3 |
| `packages/lib/server-only/document/send-document.ts` | Import + 1 chamada `assertRecipientEmailsAllowed(..., { rejectEmpty: true })` antes da validação de auth | Rede de segurança no envio; e-mail vazio também é recusado (fecha o `recipientOverride`) | 3 |
| `packages/lib/utils/env.ts` | 1 linha em `createPublicEnv`: `NEXT_PUBLIC_REVALLE_ALLOWED_DOMAINS` derivada de `NEXT_PRIVATE_ALLOWED_SIGNUP_DOMAINS` | O formulário avisa cedo, sem segunda variável para manter | 3 |
| `packages/lib/client-only/hooks/use-editor-recipients.ts` | Import + `.superRefine(refineRecipientDomains)` no fim do schema | Erro no campo de e-mail do editor v2 para e-mail fora da empresa | 3 |
| `packages/ui/primitives/document-flow/add-signers.types.ts` | Import + `.superRefine(refineRecipientDomains)`; schema reindentado pelo formatter | Idem no formulário v1 | 3 |
| `packages/lib/server-only/document/complete-document-with-token.ts` | Import + 1 chamada `assertRecipientEmailsAllowed([dictatedNextSigner?.email])` logo após `assertSenderNotDisabled` (inclui `recipientOverride?.email`) | O próximo assinante ditado e o e-mail informado ao assinar também precisa ser de domínio da empresa; a recusa vem antes de gravar qualquer coisa | 3 |
| `packages/prisma/schema.prisma` | 1 linha em `model Recipient`: `revalleGate RevalleRecipientGate? // REVALLE:`; modelos `RevalleEmailLink` e `RevalleRecipientGate` no fim do arquivo. Migrações próprias usam o prefixo de nome `revalle_` (ex.: `20261029120000_revalle_verification`) | Vínculo e-mail↔CPF e estado da verificação por destinatário (FK com `ON DELETE CASCADE`) | 3 |
| `packages/lib/server-only/document/complete-document-with-token.ts`, `packages/lib/server-only/field/sign-field-with-token.ts`, `packages/lib/server-only/field/remove-signed-field-with-token.ts`, `packages/lib/server-only/document/reject-document-with-token.ts` | Import + 1 chamada `assertRevalleGatePassed(recipient, requestMetadata)` depois de achar o destinatário | O portão vale na API, não só na tela (conclusão cobre também a própria assinatura) | 3 |
| `packages/trpc/server/envelope-router/sign-envelope-field.ts`, `packages/trpc/server/embedding-router/get-multi-sign-document.ts` | Import + 1 chamada `assertRevalleGatePassed` | Mesma regra nas rotas de campo v2 e de multi-assinatura embutida | 3 |
| `packages/trpc/server/envelope-router/get-envelope-items-by-token.ts` | Import + leitura do destinatário e `assertRevalleGatePassed` em `handleGetEnvelopeItemsByToken` (recebe `requestMetadata`) | Itens/PDF do envelope por token só depois do portão | 3 |
| `apps/remix/server/api/files/files.ts`, `apps/remix/server/api/files/routes/get-envelope-item-pdf-by-token.ts` | Imports + `isRevalleGateBlockingToken` nas 3 rotas de arquivo por token (403 JSON; tokens `qr_` ficam livres) | O PDF não vaza antes do portão | 3 |
| `apps/remix/app/routes/embed+/_v0+/sign.$token.tsx` | Import + `assertRevalleGatePassed` antes de `viewedDocument` nos dois loaders | Embed não contorna o portão | 3 |
| `apps/remix/app/routes/_recipient+/d.$token+/_index.tsx`, `packages/lib/server-only/template/create-document-from-direct-template.ts` | Loader responde 404 e a função lança `AppError(NOT_FOUND)` (constante `REVALLE_DIRECT_TEMPLATES_DISABLED` de `packages/lib/revalle/direct-templates.ts`) | Templates diretos fora do escopo: qualquer pessoa digitaria um e-mail e assinaria sem o portão | 3 |
| `packages/trpc/server/envelope-router/attachment/find-attachments.ts`, `packages/trpc/server/embedding-router/persist-embed-signature.ts` | Imports + `assertRevalleGatePassed` (anexos por token; assinatura persistida do embed) | Mesma regra nas demais leituras/escritas por token | 3 |
| `apps/remix/app/routes/embed+/_v0+/direct.$token.tsx` | Loader responde 404 (`REVALLE_DIRECT_TEMPLATES_DISABLED`) | Template direto embutido também desligado | 3 |

## Arquivos novos (não conflitam com o upstream)

| Caminho | Conteúdo | Fase |
|---|---|---|
| `CHANGES.md` | Este arquivo | 1 |
| `.gitleaks.toml` | Configuração do gitleaks | 1 |
| `scripts/revalle/check-secrets.sh` | Checagem de segredos (pre-commit e CI) | 1 |
| `scripts/revalle/smoke-test.mjs` | Fluxo envio → assinatura → selagem → download, por API | 1 |
| `scripts/revalle/verify-signed-pdf.sh` | Verifica assinatura PAdES e anexos do PDF final | 1 |
| `.github/workflows/revalle-secrets.yml` | Checagem de segredos no CI | 1 |
| `.github/workflows/revalle-image.yml` | Build e publicação da imagem no GHCR | 1 |
| `apps/remix/app/components/revalle/` | Componentes próprios | 1 |
| `packages/lib/server-only/revalle/` | Código próprio do servidor (limites de tentativas) e testes | 1 |
| `revalle/` | Deploy, backup e documentação de operação | 1 |
| `revalle/docs/deploy.md` | Passo a passo do deploy no EasyPanel e tabela de variáveis | 1 |
| `revalle/docs/certificado.md` | Certificado de homologação, troca pelo e-CNPJ A1 e renovação | 1 |
| `revalle/docs/backup.md` | Backup, conta FTP/SFTP no cPanel, chave `age` e teste de restauração | 1 |
| `revalle/docs/aceite-fase1.md` | Roteiro de aceite da Fase 1 | 1 |
| `packages/lib/revalle/recipient-domains.ts`, `packages/lib/server-only/revalle/assert-recipient-domains.ts` | Regra de domínio dos destinatários (cliente e servidor) | 3 |
| `scripts/revalle/tests/` | Testes de integração contra a stack local (`node --test`) e ajudantes | 3 |
| `packages/prisma/migrations/20261029120000_revalle_verification/migration.sql` | Tabelas `RevalleEmailLink` e `RevalleRecipientGate` | 3 |
| `packages/prisma/migrations/20261029130000_revalle_link_cpf_unique/migration.sql`, `packages/prisma/schema.prisma` (modelos `Revalle*`) | CPF único em `RevalleEmailLink`; e-mail no portão | 3 |
| `packages/lib/revalle/term.ts` | Termo de assinatura eletrônica (versão 1, provisória) | 3 |
| `apps/remix/app/routes/_share+/privacidade.tsx` | Página pública `/privacidade` | 3 |
| `packages/lib/server-only/revalle/gate/` (inclui `is-gate-blocking-token.ts`, usado pelas rotas de arquivo por token), `packages/lib/revalle/direct-templates.ts`, `packages/trpc/server/revalle-router/`, `packages/email/templates/revalle-gate-locked.tsx` | Núcleo do portão: termo, identidade (CPF + data), bloqueio e aviso por e-mail | 3 |
| `packages/trpc/server/router.ts` | Monta `revalle: revalleRouter` (marcado `// REVALLE:`) | 3 |
| `packages/lib/types/document-audit-logs.ts`, `packages/lib/utils/document-audit-logs.ts` | Eventos de auditoria `REVALLE_*` (enum, schemas, união e texto em pt-BR; marcados `// REVALLE:`) | 3 |
| `apps/remix/app/components/revalle/signing-gate/`, `packages/lib/server-only/revalle/gate/get-gate-state-for-loader.ts` | Telas do portão (termo, identidade, confirmação, bloqueado, indisponível) e consulta leve do loader | 3 |
| `apps/remix/app/routes/_recipient+/sign.$token+/_index.tsx` | Loaders V1/V2 devolvem só a tela do portão antes de carregar o documento e de `viewedDocument`; `SigningPageV1/V2` renderizam `<RevalleSigningGate>` (marcado `// REVALLE:`) | 3 |
| `apps/remix/app/routes/_recipient+/sign.$token+/{complete,rejected,expired}.tsx` | `complete`/`rejected` redirecionam para `/sign/<token>` (ou 404) e `expired` omite o título enquanto o portão não foi passado (marcado `// REVALLE:`) | 3 |
| `packages/lib/server-only/envelope/create-envelope.ts`, `packages/lib/server-only/template/create-document-from-template.ts` | Import + `withRevalleAccessAuth(...)` em volta do `createDocumentAuthOptions` (marcado `// REVALLE:`). Todo documento nasce exigindo o código de 6 dígitos por e-mail na conclusão (`TWO_FACTOR_AUTH` em `globalAccessAuth`) | 3 |
| `packages/lib/server-only/envelope/update-envelope.ts` | Import + `withRevalleAccessAuth(...)` no novo `authOptions`. O remetente não consegue desligar o código por e-mail depois | 3 |
| `packages/lib/server-only/document/send-document.ts` | Import + bloco que aplica `withRevalleAccessAuth` e grava o `authOptions` se mudou, antes da validação de auth. Rede de segurança: nada é distribuído sem o código por e-mail | 3 |
| `packages/lib/server-only/2fa/email/send-2fa-token-email.ts`, `packages/trpc/server/document-router/access-auth-request-2fa-email.ts`, `packages/lib/server-only/document/complete-document-with-token.ts` | `requestMetadata` repassado ao evento `DOCUMENT_ACCESS_AUTH_2FA_REQUESTED` e aos eventos `_FAILED`/`_VALIDATED` (marcado `// REVALLE:`). IP e user agent nos eventos do código por e-mail | 3 |
| `apps/remix/app/components/general/document-signing/access-auth-2fa-form.tsx` | Sem escolha de método: botão "Enviar código para meu e-mail", campo de 6 dígitos e "Reenviar código", em pt-BR (marcado `// REVALLE:`). Quem assina não tem conta: o método é sempre e-mail | 3 |
| `packages/lib/server-only/revalle/rate-limit-overrides.ts` (próprio) | Padrões novos: `auth.request-2fa-email` 5:200/15m, `auth.login` 10:200/15m, `api.trpc` 3000/1m, `api.file-upload` 300/1m (por IP). Uma unidade inteira atrás de um único IP não trava no uso normal | 3 |

## Checklist de atualização do upstream

1. `git fetch upstream --tags` e ler o changelog da nova versão.
2. `git merge vX.Y.Z` na branch `revalle` (merge, nunca rebase).
3. Resolver conflitos; conferir cada linha desta tabela (`git grep -n "REVALLE:"`).
4. Revisar migrações novas em `packages/prisma/migrations/` (rodam sozinhas no start).
5. Ensaio local (`revalle/deploy/compose.hml.yml`) + `scripts/revalle/smoke-test.mjs` + `scripts/revalle/verify-signed-pdf.sh`.
6. Tag `vX.Y.Z-revalle.1`, validar em homologação e só depois em produção.
