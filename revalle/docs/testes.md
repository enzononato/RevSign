# RevSign — testes de integração (para desenvolvedores e TI)

Os testes rodam contra a stack local do RevSign (`revalle/deploy/compose.hml.yml`), com a imagem reconstruída. Não há mock: eles usam o app, o Postgres e o Mailpit de verdade. Funções puras têm testes Vitest à parte (`npx vitest`).

## O que precisa estar de pé

1. Docker com a stack local no ar (app, `revsign-hml-database-1`, `revsign-hml-colaboradores-db-1` e `revsign-hml-mailpit-1`).
2. Imagem reconstruída com o código atual: `docker build -f docker/Dockerfile -t revsign:local-f3 .` (~6 min) e `REVSIGN_IMAGE=revsign:local-f3` na stack.
3. Node 24 ou mais novo (sem dependências). No WSL: `export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"`.
4. Um token de API do time (Configurações → API no site).
5. A base de colaboradores é a FICTÍCIA da stack (`revalle/colaboradores/dev-seed.sql`). Nunca rode estes testes contra produção.

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
| `REVSIGN_IDENTITY_CHECK_DISABLED` | (Opcional) `1` liga `identity-skip.test.mjs`, que só faz sentido com a stack subida com `NEXT_PRIVATE_REVALLE_IDENTITY_CHECK=disabled` (ex.: `NEXT_PRIVATE_REVALLE_IDENTITY_CHECK=disabled docker compose ... up -d documenso`; depois suba de novo sem a variável) | sem ela, o teste é pulado |
| `REVSIGN_ICP_SEAL_MODE` | (Opcional) como a stack foi subida, para `icp-seal.test.mjs`: `etsi` (padrão, variáveis ICP sem definir), `pbad` (`NEXT_PRIVATE_REVALLE_ICP_PDF_DICT=pbad`) ou `off` (`NEXT_PRIVATE_REVALLE_ICP_SEAL=false`). Os testes de outro modo aparecem como pulados. Ex.: `NEXT_PRIVATE_REVALLE_ICP_PDF_DICT=pbad docker compose ... up -d documenso`, rodar com `REVSIGN_ICP_SEAL_MODE=pbad` e depois subir de novo sem a variável | `etsi` |

`icp-seal.test.mjs` usa `scripts/revalle/inspect-pdf-signature.sh`, que precisa de `openssl` e das dependências do repositório instaladas (`npm ci`), e lê o log do container `revsign-hml-documenso-1` (`docker logs`).

Pulados aparecem como `skipped` no resumo. "Tudo verde" de verdade é: `fail 0`. Confira também o número de `skipped`.

Os testes usam `docker exec revsign-hml-database-1 psql` (nome fixo do container), o Mailpit em `http://localhost:8025` e, para simular código vencido, `docker exec revsign-hml-documenso-1 node` (o código é calculado dentro do container; a chave não sai de lá).

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

## Testes e2e do upstream (Playwright)

Os testes em `packages/app-tests` vêm do Documenso e **não são mantidos** pelo RevSign: o portão, o código por e-mail obrigatório e a exigência de domínio da empresa mudam os fluxos que eles esperam. Não use o resultado deles como critério.
