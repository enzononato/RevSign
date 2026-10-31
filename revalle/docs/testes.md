# RevSign — testes de integração (para desenvolvedores e TI)

Os testes rodam contra a stack local do RevSign (`revalle/deploy/compose.hml.yml`), com a imagem reconstruída. Não há mock: eles usam o app, o Postgres e o Mailpit de verdade. Funções puras têm testes Vitest à parte (`npx vitest run` em `packages/lib` e em `packages/signing`).

## O que precisa estar de pé

1. Docker com a stack local no ar (app, `revsign-hml-database-1`, `revsign-hml-colaboradores-db-1` e `revsign-hml-mailpit-1`).
2. Imagem reconstruída com o código atual: `docker build -f docker/Dockerfile -t revsign:local-f4 .` (~6 min) e `REVSIGN_IMAGE=revsign:local-f4` na stack. Depois de reconstruir, recrie só o app: `docker compose -f revalle/deploy/compose.hml.yml --env-file ../local-hml/hml.env up -d --force-recreate documenso`.
3. Node 24 ou mais novo (sem dependências). No WSL: `export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"`.
4. Um token de API do time (Configurações → API no site).
5. A base de colaboradores é a FICTÍCIA da stack (`revalle/colaboradores/dev-seed.sql`). Nunca rode estes testes contra produção. Numa base criada antes da Fase 4, carregue os colaboradores do aceite (seção "Aceite da Fase 4").

## Rodar a suíte completa

```sh
REVSIGN_API_TOKEN=api_... node --test --test-concurrency=1 scripts/revalle/tests/*.test.mjs
```

- `--test-concurrency=1`: todos os testes leem o código de 6 dígitos na MESMA caixa de entrada do Mailpit. Em paralelo, um teste leria o código do outro e falharia ao acaso.
- `*.test.mjs` explícito: no Node 24, passar um diretório (`node --test scripts/revalle/tests/`) não funciona.
- Para um arquivo só: `REVSIGN_API_TOKEN=api_... node --test --test-concurrency=1 scripts/revalle/tests/gate.test.mjs`.

Variáveis:

| Variável | Para que serve | Padrão |
|---|---|---|
| `REVSIGN_API_TOKEN` | Token de API do time (obrigatória) | — |
| `REVSIGN_URL` | Endereço do app | `http://localhost:3000` |
| `REVSIGN_USER_EMAIL`, `REVSIGN_USER_PASSWORD` | (Opcional) sessão de usuário comum, dono do token de API. Liga os testes de sugestões em `admin-and-suggestions.test.mjs` | sem elas, esses testes são pulados |
| `REVSIGN_ADMIN_EMAIL`, `REVSIGN_ADMIN_PASSWORD` | (Opcional) sessão de uma conta com o papel ADMIN. Liga os testes das rotas de admin (desbloquear, vínculos) e os que precisam de uma sessão com e-mail da empresa como destinatário (`getDocumentByToken`, `ACCOUNT` na conclusão); use uma conta com e-mail da empresa. A permissão é por papel; a subida do app promove a ADMIN a conta de `NEXT_PRIVATE_REVALLE_ADMIN_EMAIL`, uma das formas de ter essa conta | sem elas, esses testes são pulados |
| `REVSIGN_SENDER_API_TOKEN`, `REVSIGN_SENDER_EMAIL` | (Opcional) token de API do time pessoal de uma conta com e-mail da empresa, e o e-mail dessa conta (padrão: `REVSIGN_ADMIN_EMAIL`). Ligam o aceite da Fase 4 (`acceptance-f4.test.mjs`), em que o remetente é também o 1º signatário | sem elas, o aceite é pulado |
| `REVSIGN_IDENTITY_CHECK_DISABLED` | (Opcional) `1` liga `identity-skip.test.mjs`, que só faz sentido com a stack subida com `NEXT_PRIVATE_REVALLE_IDENTITY_CHECK=disabled` (ex.: `NEXT_PRIVATE_REVALLE_IDENTITY_CHECK=disabled docker compose ... up -d documenso`; depois suba de novo sem a variável) | sem ela, o teste é pulado |
| `REVSIGN_ICP_SEAL_MODE` | (Opcional) como a stack foi subida, para `icp-seal.test.mjs`: `etsi` (padrão, variáveis ICP sem definir), `pbad` (`NEXT_PRIVATE_REVALLE_ICP_PDF_DICT=pbad`) ou `off` (`NEXT_PRIVATE_REVALLE_ICP_SEAL=false`). Os testes de outro modo aparecem como pulados. Ex.: `NEXT_PRIVATE_REVALLE_ICP_PDF_DICT=pbad docker compose ... up -d documenso`, rodar com `REVSIGN_ICP_SEAL_MODE=pbad` e depois subir de novo sem a variável | `etsi` |
| `REVSIGN_ICP_POLICY_HASH_MODE` | (Opcional) `policy` (padrão) ou `lpa`, quando a stack sobe com `NEXT_PRIVATE_REVALLE_ICP_POLICY_HASH=lpa`: diz a `icp-seal.test.mjs` qual hash da política esperar | `policy` |

`icp-seal.test.mjs` usa `scripts/revalle/inspect-pdf-signature.sh`, que precisa de `openssl` e das dependências do repositório instaladas (`npm ci`), e lê o log do container `revsign-hml-documenso-1` (`docker logs`).

Pulados aparecem como `skipped` no resumo. "Tudo verde" de verdade é: `fail 0`. Confira também o número de `skipped`.

`branding.test.mjs` (marca RevSign) cria a cada execução uma conta nova `marca-…@revalle.com.br` (cadastro, confirmação pelo link do Mailpit, login e início do 2FA, sem ativar) e um documento assinado pelo Fernando fictício do `dev-seed.sql`; o vínculo do CPF dele é solto antes e depois. Ele confere o título `· RevSign`, o manifest, os e-mails (remetente `RevSign`; assunto do convite "Você tem um novo documento para assinar"), o certificado/log e o motivo da assinatura no PDF: rode-o com a stack subida pelo `compose.hml.yml` atual (padrões `NEXT_PRIVATE_SMTP_FROM_NAME=RevSign` e `NEXT_PRIVATE_SIGNING_REASON`).

`share-hardening.test.mjs` confere que o RevSign não cria link público de compartilhamento: `document.share` (tRPC) é recusado com o token do destinatário e com o dono logado (sem gravar linha em `DocumentShareLink`), e `/share/<slug>/opengraph` responde 404 (o teste insere e apaga uma linha própria).

`invoice-admin.test.mjs` (Fase 5) usa as sessões de `REVSIGN_ADMIN_*` (rotas `revalle.invoice.admin*`) e de `REVSIGN_USER_*` (recusa ao usuário comum). Ele **apaga e recria a lista de contas contábeis** da stack local e grava prompt e e-mail da contabilidade. O teste do estado da IA lê dentro do container se `GEMINI_API_KEY` está definida (sem mostrar o valor) e `NEXT_PRIVATE_REVALLE_INVOICE_AI`; vale para a stack subida com ou sem a chave.

`invoice-classify.test.mjs` (Fase 5) cria notas fiscais FICTÍCIAS no próprio teste (com `@cantoo/pdf-lib`: um DANFE com a chave de acesso fictícia `29241012345678000195550010000123451123456784`, uma NFS-e e um PDF "escaneado", só com imagem), envia pela API v2 e chama as rotas `revalle.invoice.get/classify/setInvoiceFlag/resuggest` com a sessão de `REVSIGN_USER_*`. Ele **substitui a lista de contas contábeis** da stack pela dele (importada pela sessão de `REVSIGN_ADMIN_*`, porque `invoice-admin.test.mjs` apaga a lista) e apaga os contadores de limite `revalle.invoice*`. Os casos com IA precisam da stack subida com o servidor falso do Gemini (seção abaixo); sem ele, só roda o caso "sem IA" (`aiAvailable: false`, a detecção funciona e nada quebra) e os outros aparecem como pulados. O caso de acesso usa também `REVSIGN_SENDER_API_TOKEN` (documento de outro time). Ele também confere: que só o arquivo detectado como NF chega à IA (um contrato no mesmo envelope fica de fora), que o CPF chega mascarado, que pedidos simultâneos geram uma chamada só, e o limite de 6 chamadas à IA por documento.

`invoice-send.test.mjs` (Fase 5) confere a escolha da conta contábil no envio: NF sem escolha é recusada (`INVOICE_ACCOUNT_REQUIRED`, 400) pela API v2, pela tela (tRPC) e pela API v1, mesmo enviada logo depois de criada; uma conta ativa envia e "Deixar para o Financeiro" fica retido (409, Fase 6); conta inativa ou inexistente dá 400; o `assets/example.pdf` envia sem nada; cada escolha gera um evento `REVALLE_INVOICE_ACCOUNT_SET`, e depois do envio o dono e o admin recebem 403 ao trocar a conta (Fase 6: quem troca é o Financeiro); trocar um arquivo apaga a escolha. Usa as mesmas sessões de `invoice-classify.test.mjs` e também **reimporta a lista de contas** (com uma conta `9.9.99` que fica inativa). Com o servidor falso do Gemini, confere ainda `acceptedSuggestion` contra a sugestão; sem ele, roda com escolha manual.

`invoice-email.test.mjs` (Fase 5) conclui NFs fictícias de verdade e confere o Mailpit: o e-mail da contabilidade tem o assunto exato (`Nota fiscal assinada: {título} · Conta {código} – {nome}` ou, numa NF de antes da Fase 6 simulada no banco, `Conta: a definir pela contabilidade`) e o PDF selado igual ao dos participantes; a reselagem pelo admin não reenvia; sem e-mail configurado e documento comum não enviam. Desde a Fase 6, a NF com conta só é selada depois da aprovação do Financeiro: o teste marca o rsadmin como Financeiro e aprova (`revalle.finance.approve`) logo depois da conclusão; a NF escaneada marcada depois da conclusão só avisa a contabilidade na aprovação. Usa as sessões `REVSIGN_ADMIN_*` e `REVSIGN_USER_*`, importa as próprias contas (a tabela é apagada pelo `invoice-admin.test.mjs`) e troca o e-mail da contabilidade por `adminUpdateSettings`, restaurando o valor anterior no final.

Em `invoice-email.test.mjs`: a suíte roda com `--test-concurrency=1`, o que importa também porque a primeira chamada de `helpers.poppler` constrói a imagem (duas construções em paralelo se atropelariam). O e-mail da contabilidade é independente dos e-mails dos participantes (sai também com eles desligados, e nunca para documento recusado ou reselagem de documento já concluído). Ele é **no máximo uma vez**: o job reserva `accountingEmailSentAt` antes de enviar e só devolve a reserva se o envio falhar com erro; se o processo cair entre a reserva e o envio, aquele e-mail se perde (aceito, em vez de arriscar duplicar). Limite do teste: `sendEmail=false` do job de selagem não é alcançável por nenhuma rota do app (só por payload direto), então o teste desliga os e-mails dos participantes pelas configurações do documento; reenviar o job direto exigiria assinar a chamada ao `/api/jobs` com a chave do app, o que o teste não faz.

`finance-admin.test.mjs` (Fase 6) usa as sessões de `REVSIGN_ADMIN_*` (rotas `revalle.finance.admin*`) e de `REVSIGN_USER_*` (dono do `REVSIGN_API_TOKEN`, usuário comum: recebe 403 nas rotas de admin e nunca é do Financeiro). Na preparação, **marca a conta de `REVSIGN_ADMIN_*` como do Financeiro** (ela fica marcada: é o membro do Financeiro dos testes da Fase 6) e importa a mesma lista de contas do `invoice-send.test.mjs`. O membro sem envolvimento na NF é uma conta nova a cada execução (`f6-membro-…@revalle.com.br`, cadastro e confirmação pelo Mailpit). O caso da migração confere as NFs (`isInvoice = YES`) criadas antes de `20261101100000_revalle_finance`; num banco sem NF anterior, ele aparece como pulado.

`finance-send.test.mjs` (Fase 6) confere o envio de NF com o Financeiro: com conta, o documento sai e fica `PENDING_APPROVAL` (inclusive um rascunho marcado `LEGACY` no banco, como os de antes da migração); com "Deixar para o Financeiro", o envio fica retido na tela (tRPC), na API v2 e na API v1 (409 `INVOICE_HELD_FOR_FINANCE`, rascunho, nenhum convite no Mailpit) e o Financeiro recebe um e-mail só; `revalle.finance.defineAccount` dá 403 a quem não é do Financeiro e 401 sem sessão, envia em nome do dono com a conta já aprovada e não reenvia na 2ª chamada nem com duas chamadas ao mesmo tempo; o remetente recebe 403 ao trocar a conta depois do envio. Também: a reserva do envio do Financeiro vale 5 minutos (4 minutos = 409; 6 = retomada); o arquivo trocado durante a definição (no banco, `fileSha256` antigo) dá "O remetente trocou o arquivo; a nota voltou para ele."; e a retomada que falha, enviada depois pelo dono, deixa no log `REVALLE_FINANCE_ACCOUNT_DEFINED` em nome de quem do Financeiro definiu. Usa as mesmas sessões do `finance-admin.test.mjs` (o rsadmin fica marcado como Financeiro) e os convites vão por e-mail (`distributionMethod: EMAIL`) para conferir no Mailpit. Um caso **apaga por instantes todos os membros do Financeiro** (retenção sem ninguém para avisar) e os devolve no fim, mesmo se falhar.

`finance-approve.test.mjs` (Fase 6) confere a selagem retida até o Financeiro aprovar: uma NF com 2 signatários fica PENDING depois das duas assinaturas (nenhum job `internal.seal-document`) e o Financeiro recebe um e-mail só ("Nota fiscal aguardando aprovação do Financeiro: {título}"); a **varredura de selagem** roda de verdade: o teste grava a linha PENDING em `BackgroundJob` e faz o POST assinado em `/api/jobs/internal.seal-document-sweep/{id}`, exatamente como o cron do provedor local faz (a assinatura é calculada **dentro do container** do app com `NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY`; a chave não sai de lá), depois de pôr no banco o `signedAt` 20 minutos atrás (a varredura só pega o que foi assinado entre 15 minutos e 6 horas atrás); uma NF `LEGACY` no mesmo estado é a prova de que a varredura rodou e selou. A reselagem pelo admin de uma NF retida chega ao job de selagem, que termina sem selar e sem falhar. `revalle.finance.approve`: 401/403/400, aprovação que sela, grava quem/quando, deixa o evento no log do PDF e manda 1 e-mail à contabilidade; repetição devolve `{ approved: false }`; aprovar antes do último assinar; NF `LEGACY`, documento comum e recusa sem retenção; disparo duplicado da selagem (o job `internal.seal-document` pelo mesmo POST assinado) numa NF concluída não muda o PDF nem o hash; aprovação simultânea; a varredura recupera uma aprovação de 20 minutos atrás com as assinaturas de 7 horas atrás (no banco) e deixa a de 5 minutos; versão `SUPERSEDED` (no banco, depois das assinaturas: desde a Task 4 o portão recusa quem assina numa versão substituída) nunca é selada. Também: a última assinatura sem ninguém no Financeiro (o caso **apaga por instantes todos os membros** e os devolve, mesmo se falhar) mostra a NF no alerta do admin (`awaitingApprovalCount`) e, com o membro de volta, a varredura de verdade pede a aprovação uma vez só, sem selar; "Definir e aprovar" (`approve` com `code`) numa NF marcada depois do envio, sem nova versão; a reselagem pelo admin de uma NF concluída que ainda espera a aprovação refaz o PDF. Usa as mesmas sessões do `finance-send.test.mjs` e troca o e-mail da contabilidade, restaurando o anterior no final.

`finance-change.test.mjs` (Fase 6) confere a troca de conta pelo Financeiro (`revalle.finance.changeAccount`), que cria uma NOVA VERSÃO da NF para todos assinarem de novo: a versão antiga fica `SUPERSEDED` e some das listas (excluída sem o e-mail de cancelamento); o signatário com a página antiga aberta recebe "Este documento foi substituído por uma nova versão (conta contábil alterada)." ao assinar o campo, pedir o código, concluir, recusar e abrir a página; a v2 sai com o título "(v2)", os mesmos destinatários e campos e a conta nova já aprovada, e é selada quando todos assinam; o Mailpit recebe o aviso com o motivo (o remetente com o link da página da NF, cada signatário com o próprio link de assinatura da v2) e os convites da v2 (`distributionMethod: EMAIL`; os convites da v1 são esperados antes de assinar, para não chegarem depois do código). Com o envio da v2 falhando, o aviso só sai quando a v2 é enviada. Com a v2 apagada pelo dono (`/envelope/delete`), o cartão do Financeiro (`revalle.finance.get`) oferece trocar de novo (`canRetakeChange`) e não aponta mais para ela. Também: 400/403/401/404, duas trocas simultâneas = 1 v2, NF concluída, NF retida com todos assinados (a varredura de verdade e a reselagem não selam a antiga), "(v3)", e as falhas: **zera por instantes a cota de documentos (`OrganisationClaim.documentQuota`) da organização do dono** para a criação da v2 falhar (restaura no fim, mesmo se falhar), muda no banco o e-mail de um destinatário para `@example.com` para o envio da v2 falhar, simula no banco uma troca que morreu no meio, apaga a v2 para a troca ser retomada e **desativa por instantes a conta de `REVSIGN_USER_*`** (dono das NFs) para conferir a recusa (reativa no fim, mesmo se falhar). Também confere a 2ª falha de envio da v2 (a conta não se perde), o envio da v2 pelo remetente, as configurações copiadas (idioma, ordem, expiração, lembretes) e que não sai e-mail de cancelamento. Usa as mesmas sessões do `finance-send.test.mjs`.

`finance-proof.test.mjs` (Fase 6) confere que a conta contábil faz parte do que é assinado: a página de assinatura de uma NF (V2, e V1 criada por `/api/v2-beta/document/create` e enviada pela API v1) mostra "Nota fiscal · Conta contábil: {código} – {nome}" no HTML do servidor, só depois do portão; o documento comum não; a prova de cada signatário grava `invoiceAccount` (nula no comum); a NF retida mostra "Aguardando aprovação do Financeiro" na conclusão; aprovada e selada, o certificado (`pdftotext`) traz a linha do documento com quem aprovou e quando (lido do banco) e "Conta contábil vista ao assinar" em cada signatário, e o `/verificar` mostra a conta e a aprovação; numa versão substituída pela troca de conta, o `/verificar` com o código antigo diz "Substituído por uma nova versão em {data} (conta contábil alterada)" sem nenhum código nem o id da nova versão; e o nome da conta fica congelado na aprovação: o teste **renomeia a conta 2.1.03 reimportando a lista** (mesmo número, outro nome), ressela pelo admin e confere o nome aprovado no certificado e no `/verificar` (a lista original volta no fim, mesmo se falhar); o mesmo com o nome de quem aprovou (o teste **renomeia por instantes a conta de `REVSIGN_ADMIN_*`** e devolve o nome no fim). O `sign` abre a página de assinatura depois do portão, como a tela: a prova só congela a conta que a página mostrou. Quem assina sem abrir a página (como pelo embed) ou com a página aberta antes de a conta existir fica sem a conta na prova e sem a linha no certificado. Usa as mesmas sessões do `finance-send.test.mjs`.

Poppler: `helpers.poppler` roda `pdftotext`, `pdfinfo` etc. na imagem local `revsign-test-poppler:local`, construída uma vez a partir de `scripts/revalle/tests/poppler.Dockerfile` (alpine:3.22 + poppler-utils) se ainda não existir. Não há mais `apk add` a cada chamada, que falhava de vez em quando por rede ou disco. Para refazer a imagem: `docker rmi revsign-test-poppler:local`.

Os testes usam `docker exec revsign-hml-database-1 psql` (nome fixo do container), o Mailpit em `http://localhost:8025` e, para simular código vencido, `docker exec revsign-hml-documenso-1 node` (o código é calculado dentro do container; a chave não sai de lá).

Conexões ociosas: o app fecha conexões keep-alive paradas. Depois de uma espera longa (selagem, reselagem), o próximo pedido pode cair numa conexão já fechada (`EPIPE`, `ECONNRESET` ou `UND_ERR_SOCKET` "other side closed"). Os ajudantes (`helpers.mjs`) repetem **uma vez** os pedidos que podem ser repetidos sem efeito colateral (GET: API, downloads, Mailpit, consultas tRPC) com `fetchIdempotent`/`retryOnStaleSocket`. Pedidos POST não são repetidos, com uma exceção: a criação de documento nos testes de carimbo, selagem e aceite (`retryCreateOnStaleSocket`), nos mesmos três erros. Risco aceito: um `UND_ERR_SOCKET` pode chegar depois de o servidor já ter criado o documento; aí a repetição cria outro e o primeiro fica como envelope de teste órfão (inofensivo na stack local descartável; o teste segue com o segundo). Não dá para restringir a repetição a `EPIPE`/`ECONNRESET`: o erro que aparece na prática nessa criação é justamente o `UND_ERR_SOCKET` do socket ocioso.

## Servidor falso do Gemini (Fase 5)

A sugestão de conta contábil da nota fiscal chama o Gemini, uma API externa e paga. Os testes não chamam o Google: o app fala com `scripts/revalle/tests/fake-gemini.mjs`, um servidor falso que responde no formato da API `generateContent`. É uma exceção deliberada à regra "sem mock": o dublê fica na **fronteira de rede**, no lugar do Google; o app é o mesmo, só muda o endereço (`NEXT_PRIVATE_REVALLE_GEMINI_BASE_URL`). Tudo dentro do app (texto do PDF, detecção, cache, job, limites, validação da resposta) roda de verdade.

Subir a stack com o servidor falso (por cima do `compose.hml.yml`):

```sh
docker compose -f revalle/deploy/compose.hml.yml -f revalle/deploy/compose.test.yml --env-file ../local-hml/hml.env up -d
```

- `compose.test.yml` acrescenta o serviço `fake-gemini` (imagem `node:24-alpine`, script montado só para leitura, porta `127.0.0.1:8787`) e define no app `GEMINI_API_KEY=test-key` e `NEXT_PRIVATE_REVALLE_GEMINI_BASE_URL=http://fake-gemini:8787/v1beta`. Nunca use esse arquivo em homologação ou produção.
- Para voltar à stack sem IA, suba de novo só com o `compose.hml.yml` (o app é recriado sem a chave; o `fake-gemini` pode ser parado com `docker compose -f revalle/deploy/compose.hml.yml -f revalle/deploy/compose.test.yml --env-file ../local-hml/hml.env stop fake-gemini`).
- Depois de editar `fake-gemini.mjs`, recrie o serviço (`... up -d --force-recreate fake-gemini`): o arquivo é montado sozinho e o container continua vendo a versão antiga.
- A suíte inteira deve passar nos dois jeitos: com o `compose.test.yml` (caminho da IA) e sem ele (sem chave, `aiAvailable: false`).
- **Guarda contra chamada paga:** `invoice-classify`, `invoice-send`, `invoice-email` e `acceptance-f5` chamam `assertNoPaidGeminiCalls()` (`helpers.mjs`) antes de criar qualquer NF. Se o app tiver `GEMINI_API_KEY` e `NEXT_PRIVATE_REVALLE_GEMINI_BASE_URL` não for `http://fake-gemini:8787/v1beta` (ex.: uma chave de verdade no `hml.env` para teste manual), a suíte para com a mensagem "Parado: o app tem GEMINI_API_KEY e não aponta para o servidor falso…". Para chamar o Gemini de propósito, defina `REVALLE_TEST_GEMINI_API_KEY`. O teste puro da guarda é `gemini-guard.test.mjs`.

O que o servidor falso faz (o teste o controla pela porta 8787 do host):

| Rota | Para que serve |
|---|---|
| `POST /v1beta/models/{modelo}:generateContent` | O que o app chama. Responde no formato do Gemini com o JSON do modo programado. Confere a chave `test-key` no cabeçalho `x-goog-api-key` |
| `POST /__program {"mode": ..., "accountCode": ...}` | Modo da próxima resposta: `ok` (a conta de `accountCode`, ou a primeira da lista), `unknown-account` (conta que não existe), `garbage` (texto que não é JSON), `slow` (25 s; o app desiste em 20 s), `error` (HTTP 500) |
| `GET /__calls` | Chamadas recebidas: modelo, se veio PDF ou texto, tamanhos, as instruções e as partes da mensagem |
| `POST /__reset` | Apaga as chamadas e volta ao modo `ok` |

Rodar só este teste (com a stack subida com o `compose.test.yml`):

```sh
REVSIGN_API_TOKEN=api_... REVSIGN_USER_EMAIL=... REVSIGN_USER_PASSWORD=... \
REVSIGN_ADMIN_EMAIL=... REVSIGN_ADMIN_PASSWORD=... REVSIGN_SENDER_API_TOKEN=api_... \
node --test --test-concurrency=1 scripts/revalle/tests/invoice-classify.test.mjs
```

- `REVSIGN_FAKE_GEMINI_URL`: endereço do servidor falso visto do host (padrão `http://localhost:8787`).
- **Perna opcional com o Gemini de verdade:** com `REVALLE_TEST_GEMINI_API_KEY=<chave>` no ambiente do teste, um caso programa o servidor falso no modo `proxy`, que repassa UMA chamada (o DANFE fictício) ao Google com essa chave, e confere só que a resposta passa na validação ou vira `FAILED` com um código curto. A chave fica só na memória do servidor falso (não é devolvida nem registrada). Sem a variável, o caso é pulado. Custa uma chamada paga.
- O caso "o log do app não tem o texto da NF" lê `docker logs revsign-hml-documenso-1` desde o início do teste e procura uma frase da NF fictícia e a chave de acesso.

## Tradução (overlay pt-BR)

As traduções do RevSign ficam no overlay `packages/lib/translations/revalle/pt-BR.po`; os catálogos do upstream (`packages/lib/translations/<idioma>/web.po`) nunca são editados no git.

- `npm run translate:revalle` faz o mesmo que o build da imagem: extrai as msgids, aplica o overlay, valida (`check-po.mjs --locale pt-BR --warn-missing`) e compila. `npm run dev` e `npm run dev:remix` já o rodam, então o desenvolvimento local mostra as telas como na imagem. A última linha do `check-po` é o resumo (`N entradas, M sem tradução, K obsoletas no overlay, E erros`).
- Ele reescreve os `web.po` do upstream no lugar. Depois de rodar, desfaça com `git checkout -- 'packages/lib/translations/*/web.po'`. O pre-commit (`scripts/revalle/check-secrets.sh --staged`) recusa o commit se algum desses arquivos estiver no stage; num merge do upstream (`MERGE_HEAD`) eles passam, e `REVALLE_ALLOW_UPSTREAM_PO=1 git commit …` libera de propósito (ex.: reverter um commit acidental).
- Testes puros do overlay, do validador e dessa guarda: `node --test scripts/revalle/tests/i18n.test.mjs` (não precisam da stack).
- `sh scripts/revalle/check-image-i18n.sh <imagem>` confere que o catálogo pt-BR compilado dentro da imagem tem o overlay (o CI roda antes de publicar).

## Aceite da Fase 4

`scripts/revalle/tests/acceptance-f4.test.mjs` é o aceite da spec §7.3: um documento com três signatários em ordem (o próprio remetente, um colaborador já vinculado e um na primeira assinatura), conferido no PDF final, no `/verificar` e na selagem. O que ele confere, em linguagem simples: `prova.md`, seção 4.

Antes da primeira vez:

1. **Colaboradores do aceite na base.** São os fictícios 7 a 9 do `dev-seed.sql` (`Teste Aceite F4 1/2/3`), exclusivos deste teste. Uma base nova já os carrega. Numa base criada antes, rode só o bloco deles (pode repetir, não duplica):
   ```sh
   sed -n '/aceite-f4:inicio/,/aceite-f4:fim/p' revalle/colaboradores/dev-seed.sql \
     | docker exec -i revsign-hml-colaboradores-db-1 psql -U postgres -d colaboradores -v ON_ERROR_STOP=1
   ```
2. **Token de API do remetente.** Entre no site com a conta de e-mail da empresa que será o remetente (em homologação, a de `REVSIGN_ADMIN_EMAIL`), abra **Configurações → API** e crie um token para o time pessoal. Guarde-o fora do repositório. Nunca crie token por SQL.

Rodar (só o aceite; a suíte inteira o inclui quando as variáveis estão definidas):

```sh
REVSIGN_API_TOKEN=api_... REVSIGN_SENDER_API_TOKEN=api_... REVSIGN_SENDER_EMAIL=remetente@revalle.com.br \
node --test --test-concurrency=1 scripts/revalle/tests/acceptance-f4.test.mjs
```

- Leva cerca de 1 minuto (três conclusões, a selagem e o poppler).
- Vínculos: o vínculo e-mail ↔ CPF é permanente e o CPF é único. Por isso cada execução usa e-mails novos para os signatários 2 e 3 e solta antes os vínculos dos CPFs fictícios 8 e 9. O remetente fica vinculado ao CPF fictício 7; se outro teste soltar esse vínculo, o aceite o refaz com um documento descartável (que ele mesmo exclui).
- Esperado: todos os testes `ok`, nenhum `skipped` no arquivo do aceite.

## Aceite da Fase 5

`scripts/revalle/tests/acceptance-f5.test.mjs` é o aceite das notas fiscais (spec §8, §9 e §11), de ponta a ponta:

1. o admin (`REVSIGN_ADMIN_*`) importa 4 contas próprias do teste e grava um prompt e um e-mail da contabilidade novo a cada execução;
2. um remetente da empresa sobe um DANFE fictício; com o servidor falso do Gemini a sugestão sai e ele aceita (sem o servidor falso, escolhe a mesma conta na lista);
3. uma NFS-e sem conta (o servidor falso responde erro: fica sem sugestão). Desde a Fase 6 "Deixar para o Financeiro" retém o envio, então ela é enviada com uma conta e convertida no banco, logo depois do envio, numa NF de antes da Fase 6 deixada para a contabilidade (`LEGACY`, "a definir pela contabilidade");
4. um contrato comum (`assets/example.pdf`), enviado e deixado pendente;
5. dois signatários assinam cada NF (portão com a Maria fictícia + código por e-mail) e as NFs são concluídas. Desde a Fase 6 o DANFE fica retido depois das duas assinaturas e o admin (`REVSIGN_ADMIN_*`, marcado como Financeiro na preparação) aprova pela rota `revalle.finance.approve`; a NFS-e é de antes da Fase 6 e conclui sem aprovação;
6. `revalle.invoice.find`: 2 NFs para o remetente, 0 para um terceiro sem envolvimento, só a NF em que é signatário para um colega (destinatário pelo e-mail; desde a Fase 6 com o link da página da NF), as 2 para o admin (contrato fora; como o admin dos testes é do Financeiro, o link é a página da NF); filtros de período, status, conta e "deixadas"; `/notas-fiscais` abre com sessão e manda para o login sem;
7. `/notas-fiscais/csv`: `text/csv; charset=utf-8`, `notas-fiscais-AAAA-MM-DD.csv` (data de Brasília), BOM, cabeçalho exato (desde a Fase 6 com `financeiro;aprovado_por` no fim), 2 linhas com as contas certas (`aceitou_sugestao` e `sugestao_ia` vazios sem sugestão); os mesmos filtros da tela; terceiro = só o cabeçalho; sem sessão = login; filtro inválido = 400;
8. 2 e-mails para a contabilidade, com os assuntos exatos (nenhum para o contrato);
9. `/privacidade` tem a frase exata da spec §9;
10. Fase 6 (a conta faz parte do que é assinado): o certificado do DANFE traz "Conta contábil: 4.1.07 – … · aprovada pelo Financeiro ({nome}) em {data} (horário de Brasília)" e "Conta contábil vista ao assinar: 4.1.07" nos 2 signatários, e nenhuma das outras contas; o PDF da NFS-e (sem conta) não tem conta nem "conta contábil" (`pdftotext` pelo `helpers.poppler`).
11. o remetente exclui a NFS-e (`/envelope/delete`, exclusão suave de documento concluído): ela some da tela e da planilha dele; o admin continua vendo, com `deleted` e `excluído pelo remetente` na coluna `status`.

O remetente, o terceiro e o colega são **contas novas a cada execução** (`f5-…@revalle.com.br`: cadastro, confirmação pelo link do Mailpit e login, como em `branding.test.mjs`); o token de API do remetente é criado pela rota `apiToken.create` da sessão dele. O prompt e o e-mail da contabilidade anteriores voltam no final. A lista de contas fica com as 4 do aceite (os outros testes de NF importam a própria).

```sh
REVSIGN_API_TOKEN=api_... REVSIGN_ADMIN_EMAIL=... REVSIGN_ADMIN_PASSWORD=... \
node --test --test-concurrency=1 scripts/revalle/tests/acceptance-f5.test.mjs
```

- Rode com a stack subida com o `compose.test.yml` (caminho da IA) e também sem ele; os dois caminhos devem passar.
- O limite de 10.000 linhas da planilha não é exercitado aqui (exigiria criar 10.001 notas); a decisão (`isOverInvoiceExportLimit`) tem teste Vitest e o código conta antes de montar a planilha.
- `invoice-send`, `invoice-email` e este aceite só seguem o caminho da IA com o app configurado (`aiStatus = CONFIGURED`) E o servidor falso no ar; com o app sem chave, os casos de IA são pulados mesmo com o container `fake-gemini` de pé.

## Aceite da Fase 6

`scripts/revalle/tests/acceptance-f6.test.mjs` é o aceite do Financeiro (spec §8, itens 1 a 7, e o passo 8 da revisão final), de ponta a ponta, com e-mails reais no Mailpit:

1. o admin (`REVSIGN_ADMIN_*`) marca como Financeiro uma **conta nova** (cadastro + confirmação pelo Mailpit, como no `finance-admin`); `revalle.finance.me` diz que ela é do Financeiro e que um terceiro (outra conta nova) não é;
2. uma NF com 2 signatários (conta `7.6.01`, convites por e-mail) é assinada pelos dois e fica **retida** (PENDING, `PENDING_APPROVAL`); o membro recebe "Nota fiscal aguardando aprovação do Financeiro: {título}" com a conta e o link `/notas-fiscais/{id}`; na lista ela está em "Aguardando o Financeiro" (`financeiro: 'pendentes'`) com a situação, a versão e o link da página da NF; a **página da NF** (HTML do servidor) abre para o membro (título, remetente, signatários) e para o dono, dá **404** para o terceiro e manda para o login sem sessão; o PDF da prévia (`/notas-fiscais/{id}/pdf/{item}`) é `application/pdf` para o membro e 404 para o terceiro; `revalle.finance.get` traz o estado, a conta e quem escolheu;
3. o membro aprova: a NF é selada, o certificado (`pdftotext`) traz "Conta contábil: 7.6.01 – … · aprovada pelo Financeiro ({nome do membro}) em {data} (horário de Brasília)" e as 2 linhas "vista ao assinar", e a contabilidade recebe o e-mail; um documento comum concluído e **marcado como NF depois** aparece em "Aguardando o Financeiro" e, aprovado, vai à contabilidade;
4. outra NF: o membro **troca a conta** (`7.6.02`, com motivo) depois da 1ª assinatura: o link antigo mostra a mensagem do portão; o remetente recebe o aviso com o texto exato e o link da página da v2, e os 2 signatários com o próprio link de assinatura da v2; os convites da v2 chegam; a versão antiga continua na lista do dono como `SUPERSEDED` v1 (não "excluída") e a v2 como `APPROVED` v2; a página de cada versão aponta para a outra (a antiga mostra o motivo); a v2 é assinada e selada com a conta nova (a antiga não aparece como conta vista nem aprovada) e a contabilidade recebe "Conta alterada pelo Financeiro ({membro}) — motivo: {motivo}";
5. "Deixar para o Financeiro": o envio responde 409, o documento fica rascunho (`AWAITING_ACCOUNT`), o membro recebe "Nota fiscal aguardando o Financeiro: {título}" com o link da página da NF e o signatário não recebe nada; o rascunho aparece para o membro ("Aguardando o Financeiro", sem data de envio) e para o dono, não para o terceiro; "Definir conta e enviar" (`defineAccount`) envia e o convite sai; assinada, a contabilidade recebe "Conta definida pelo Financeiro ({membro})";
6. o terceiro e o remetente (fora do Financeiro) recebem **403** em `approve`, `changeAccount`, `defineAccount` e `get`, e nada muda;
7. uma NF de antes da Fase 6 (`LEGACY`, posta no banco logo depois do envio) conclui sem aprovação, vai à contabilidade e não pede aprovação;
8. a NF do passo 3 marcada depois da conclusão (já enviada à contabilidade) tem a conta trocada: o e-mail da contabilidade da v2 traz "Substitui o envio da versão anterior: {título}";
e a planilha do membro (`?de=hoje`): colunas `financeiro` (Aprovada, Substituída, "Antiga, sem aprovação") e `aprovado_por` no fim, link da página da NF, filtro `financeiro=substituidas`; a do terceiro não tem nenhuma dessas NFs.

```sh
REVSIGN_API_TOKEN=api_... REVSIGN_USER_EMAIL=... REVSIGN_USER_PASSWORD=... REVSIGN_ADMIN_EMAIL=... REVSIGN_ADMIN_PASSWORD=... \
node --test --test-concurrency=1 scripts/revalle/tests/acceptance-f6.test.mjs
```

- Importa 2 contas próprias (`7.6.01`, `7.6.02`) e troca o e-mail da contabilidade por um novo a cada execução (o anterior volta no fim). O membro novo é desmarcado no fim.
- Rode com e sem o `compose.test.yml`: o aceite não depende da sugestão da IA.

## Teste de fumaça (smoke)

Cria um documento, envia, passa pelo portão, assina, espera a selagem e baixa o PDF original e o final.

```sh
REVSIGN_API_TOKEN=api_... \
SMOKE_CPF=93457210888 SMOKE_BIRTH_DATE=31/12/1999 \
SIGNER_EMAIL=ensaio@revalle.com.br \
node scripts/revalle/smoke-test.mjs smoke-output/
```

- `SMOKE_CPF` e `SMOKE_BIRTH_DATE` (dd/MM/yyyy): de um colaborador da base. O exemplo é o Fernando fictício do `dev-seed.sql`. Sem eles, o script falha com mensagem clara quando o portão pede identidade. Com `NEXT_PRIVATE_REVALLE_IDENTITY_CHECK=disabled` nada é pedido.
- O código de 6 dígitos é lido sozinho no Mailpit (`SMOKE_MAILPIT_URL`, padrão `http://localhost:8025/api/v1`).
- O vínculo e-mail ↔ CPF é PERMANENTE. Para repetir o teste com o mesmo colaborador fictício, limpe o vínculo dele antes (ou use outro CPF fictício, ou o mesmo `SIGNER_EMAIL` que já está vinculado a ele):
  ```sh
  docker exec revsign-hml-database-1 psql -U documenso -d documenso -c "DELETE FROM \"RevalleEmailLink\" WHERE cpf = '93457210888';"
  ```
- O e-mail do assinante precisa ser de um domínio permitido (`NEXT_PRIVATE_ALLOWED_SIGNUP_DOMAINS`).

## Verificar o PDF assinado

```sh
sh scripts/revalle/verify-signed-pdf.sh smoke-output/final.pdf smoke-output/original.pdf
```

Confere a assinatura digital (íntegra e cobrindo o documento todo) e, com o original, que o final tem páginas a mais (certificado e log). Os nomes reais dos arquivos são os que o smoke imprime no fim.

Para ver o dicionário da assinatura, o DocMDP e os atributos assinados (política ICP-Brasil):

```sh
sh scripts/revalle/inspect-pdf-signature.sh smoke-output/final.pdf          # resumo e signedAttrs
sh scripts/revalle/inspect-pdf-signature.sh smoke-output/final.pdf --full   # estrutura CMS inteira
```

## Celular (360 px)

`scripts/revalle/mobile-check.mjs` passa pelo caminho de quem assina numa tela de celular (360×740, escala 2): cria e envia um documento pela API, abre o link, passa pelo portão (termo, CPF e data de nascimento do Fernando fictício do `dev-seed.sql`, "sou eu"), abre pelo menu de ações os diálogos "Baixar PDF" e "Recusar" e os fecha (depois de cada um, o 1º toque num campo tem de abri-lo), assina um campo de assinatura e um de texto, pede o código por e-mail (lido no Mailpit) e conclui. Em cada passo tira um print e confere:

- sem rolagem horizontal (`document.scrollingElement.scrollWidth <= 360`);
- todo botão visível (`button` ou `role=button`) com pelo menos 44 px de altura (caixa de seleção vale pela área do `<label>` dela);
- nada cortado para fora da tela à direita.

Com `REVSIGN_USER_EMAIL` e `REVSIGN_USER_PASSWORD` (sessão do dono do token), antes do caminho de quem assina ele também confere o **envio de uma nota fiscal fictícia** no celular: abre o editor, o diálogo de envio com o bloco "Nota fiscal · Conta contábil" (`00a-nf-envio.png`), escolhe "Deixar para o Financeiro" (`00b-nf-escolhida.png`), envia (o envio fica retido: confere o aviso "Enviado para o Financeiro definir a conta…" e, ao reabrir, o bloco só de leitura "Aguardando o Financeiro definir a conta" com o envio bloqueado, `00b2-nf-retida.png`) e confere o cartão "Conta contábil" só de leitura ("Aguardando aprovação do Financeiro", sem botões) de outra NF enviada com a primeira conta ativa da lista (`00c-nf-cartao.png`; sem conta ativa, o passo falha pedindo a importação). Nesses passos a conferência vale só dentro do bloco da nota fiscal e do cartão: o editor do upstream não foi feito para celular (a 360 px a página passa da largura da tela e as abas "E-mail"/"Nenhum" do diálogo de envio têm 32 px). Depois abre a página **Notas fiscais** do remetente (`00d-notas-fiscais.png`), conferida assim: filtros e botões da página com 44 px e nenhuma rolagem horizontal da página inteira (a tabela rola dentro do próprio quadro). Os ícones de busca e menu do cabeçalho do upstream (24 px) ficam fora dessa conferência. A sessão vai para o container pelo ambiente, nunca na linha de comando. Sem essas variáveis, o passo é pulado.

```sh
REVSIGN_API_TOKEN=api_... node scripts/revalle/mobile-check.mjs /tmp/prints-celular
```

- O navegador roda na imagem Docker `mcr.microsoft.com/playwright:v1.56.1-noble` (o WSL não abre o Chromium), com `--network host` e o repositório montado só para leitura; o script usa o pacote `playwright` do `node_modules` do repo (mesma versão da imagem). Na primeira vez o `docker pull` baixa ~2 GB. Outra imagem: `MOBILE_CHECK_IMAGE`.
- Com a sessão do remetente (`REVSIGN_USER_*`), a NF enviada com conta também é aberta por quem assina (portão com a Maria fictícia) e o bloco "Nota fiscal · Conta contábil" tem de aparecer na primeira tela (`00j-nf-conta-ao-assinar.png`, Fase 6).
- Fase 6, com `REVSIGN_ADMIN_EMAIL`/`REVSIGN_ADMIN_PASSWORD` também (o rsadmin, marcado como Financeiro pelo script): a **página da NF** dessa NF enviada, inteira e com a prévia do PDF (`00k-nf-financeiro.png`), o cartão "Financeiro" (`00k2-nf-cartao-financeiro.png`), a confirmação de "Aprovar conta" (`00l-nf-aprovar-confirmar.png`), "Trocar conta" com a lista, o motivo e o contador (`00m-nf-trocar-conta.png`) e a confirmação "Todos vão assinar de novo uma nova versão." (`00m2-nf-trocar-confirmar.png`), o cartão de uma NF retida com "Definir conta e enviar" (`00n-nf-definir-conta.png`) e a página **Notas fiscais** do Financeiro, que tem de abrir em "Aguardando o Financeiro" (`00o-notas-fiscais-financeiro.png`). Os diálogos são abertos e cancelados: nada é aprovado nem trocado.
- Os prints (`01-termo.png` … `15-concluido.png`) e o `report.json` ficam na pasta indicada (padrão `/tmp/revsign-mobile-check/`). Se o fluxo quebrar no meio, sai `erro.png`.
- "Tudo verde" é a última linha `mobile-check: tudo verde` e código de saída 0.
- O vínculo do CPF do Fernando fictício é solto antes e depois (como no `branding.test.mjs`); o e-mail do signatário é novo a cada execução.

## Testes e2e do upstream (Playwright)

Os testes em `packages/app-tests` vêm do Documenso e **não são mantidos** pelo RevSign: o portão, o código por e-mail obrigatório e a exigência de domínio da empresa mudam os fluxos que eles esperam. Não use o resultado deles como critério.
