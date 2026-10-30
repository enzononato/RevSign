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

Os testes usam `docker exec revsign-hml-database-1 psql` (nome fixo do container), o Mailpit em `http://localhost:8025` e, para simular código vencido, `docker exec revsign-hml-documenso-1 node` (o código é calculado dentro do container; a chave não sai de lá).

Conexões ociosas: o app fecha conexões keep-alive paradas. Depois de uma espera longa (selagem, reselagem), o próximo pedido pode cair numa conexão já fechada (`EPIPE`, `ECONNRESET` ou `UND_ERR_SOCKET` "other side closed"). Os ajudantes (`helpers.mjs`) repetem **uma vez** os pedidos que podem ser repetidos sem efeito colateral (GET: API, downloads, Mailpit, consultas tRPC) com `fetchIdempotent`/`retryOnStaleSocket`. Pedidos POST não são repetidos, com uma exceção: a criação de documento nos testes de carimbo, selagem e aceite (`retryCreateOnStaleSocket`), nos mesmos três erros. Risco aceito: um `UND_ERR_SOCKET` pode chegar depois de o servidor já ter criado o documento; aí a repetição cria outro e o primeiro fica como envelope de teste órfão (inofensivo na stack local descartável; o teste segue com o segundo). Não dá para restringir a repetição a `EPIPE`/`ECONNRESET`: o erro que aparece na prática nessa criação é justamente o `UND_ERR_SOCKET` do socket ocioso.

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

```sh
REVSIGN_API_TOKEN=api_... node scripts/revalle/mobile-check.mjs /tmp/prints-celular
```

- O navegador roda na imagem Docker `mcr.microsoft.com/playwright:v1.56.1-noble` (o WSL não abre o Chromium), com `--network host` e o repositório montado só para leitura; o script usa o pacote `playwright` do `node_modules` do repo (mesma versão da imagem). Na primeira vez o `docker pull` baixa ~2 GB. Outra imagem: `MOBILE_CHECK_IMAGE`.
- Os prints (`01-termo.png` … `15-concluido.png`) e o `report.json` ficam na pasta indicada (padrão `/tmp/revsign-mobile-check/`). Se o fluxo quebrar no meio, sai `erro.png`.
- "Tudo verde" é a última linha `mobile-check: tudo verde` e código de saída 0.
- O vínculo do CPF do Fernando fictício é solto antes e depois (como no `branding.test.mjs`); o e-mail do signatário é novo a cada execução.

## Testes e2e do upstream (Playwright)

Os testes em `packages/app-tests` vêm do Documenso e **não são mantidos** pelo RevSign: o portão, o código por e-mail obrigatório e a exigência de domínio da empresa mudam os fluxos que eles esperam. Não use o resultado deles como critério.
