# RevSign — passo a passo do deploy no EasyPanel (homologação)

Para quem: Enzo (TI). Tudo é feito no painel do EasyPanel e no cPanel. Não precisa de SSH.

Endereço de homologação: `assinatura-hml.revalle.com.br`. A produção (`assinatura.revalle.com.br`) repete os mesmos passos depois.

Versões da imagem usadas neste guia:

- App: `ghcr.io/enzononato/revsign:v2.21.1-revalle.5`
- Backup: `ghcr.io/enzononato/revsign-backup:v2.21.1-revalle.5`

## O que você precisa ter antes

- Acesso ao EasyPanel da VPS.
- Acesso ao cPanel (Zone Editor, E-mail Accounts, FTP Accounts).
- O WSL com a pasta de segredos gerada (passo 0).
- Uma conta no GitHub com acesso ao repositório `enzononato/RevSign`.

## Passo 0 — Gerar os segredos (no WSL, uma vez)

Isto cria as senhas, o certificado de homologação e a chave do backup, tudo fora do repositório.

1. Abra o terminal do WSL.
2. Entre na pasta do repositório: `cd ~/projetos/assinaturas-revalle/documenso`
3. Rode (a pasta de saída precisa estar fora de qualquer repositório Git e vazia):
   `bash scripts/revalle/generate-hml-secrets.sh ~/projetos/assinaturas-revalle/local-hml/hml-easypanel`
4. Abra a pasta criada. Ela tem:
   - `app.env`: variáveis do site (serviço `revsign`), com alguns `<preencher>`.
   - `backup.env`: variáveis do serviço de backup (`revsign-backup`), com `<preencher>` e linhas de cópia remota comentadas (`#`).
   - `backup-age-identity.txt`: a chave PRIVADA dos backups.
   - `cert/`: o certificado `cert.p12` e a senha dele (`passphrase.txt`).
   - `LEIA-ME.txt`: resumo do que cada arquivo é.
5. Guarde `backup-age-identity.txt` e `cert/` no cofre de senhas. Eles não vão para a VPS.

## Passo 1 — Tornar os pacotes do GHCR públicos (uma vez)

Por quê: o EasyPanel baixa a imagem sem senha. Se o pacote for privado, o download falha.

Faça para cada um dos dois pacotes (`revsign` e `revsign-backup`):

1. Entre no GitHub e abra o perfil `enzononato`.
2. Clique em **Packages**.
3. Clique no pacote (`revsign`).
4. Clique em **Package settings** (barra lateral).
5. Role até **Danger Zone** e clique em **Change visibility**.
6. Escolha **Public**, digite o nome do pacote para confirmar e clique em confirmar.
7. Repita para `revsign-backup`.

## Passo 2 — Criar o banco de dados

Escolha UMA das opções. A recomendada é a A.

### Opção A (recomendada): novo serviço Postgres 17 só para o RevSign

Por quê: é o mais simples e deixa o RevSign totalmente isolado da base de colaboradores.

1. No EasyPanel, abra (ou crie) o projeto do RevSign, por exemplo `revsign`.
2. Clique em **+ Service**.
3. Clique em **Postgres**.
4. No campo **Service Name**, escreva `revsign-db`.
5. No campo **Image**, escreva `postgres:17`.
6. No campo **Password**, cole uma senha forte (gere com `openssl rand -hex 32` no WSL). Guarde no cofre.
7. Confira os campos de usuário e banco: use usuário `revsign` e banco `revsign` (se o painel não deixar mudar, use os que ele mostrar e ajuste a URL do passo 4).
8. Clique em **Create** e espere o serviço ficar verde.
9. Abra o serviço `revsign-db`. Na aba **Overview** (ou **Credentials**), procure **Internal Connection URL**. Copie. Ela tem este formato:
   `postgres://revsign:SENHA@revsign_revsign-db:5432/revsign`
   O pedaço `revsign_revsign-db` é `<projeto>_<serviço>`: é o nome interno, que só funciona de dentro da VPS.

### Opção B: usar o Postgres que já existe

Só use se não puder criar outro serviço. O RevSign deve ter banco e usuário PRÓPRIOS. Nunca use o banco da base de colaboradores.

1. Abra um terminal SQL no Postgres existente (pelo próprio EasyPanel, se ele oferecer; ou outro cliente SQL ligado ao servidor), logado como administrador.
2. Rode (troque `SENHA-FORTE` por uma senha gerada):

```sql
CREATE USER revsign WITH PASSWORD 'SENHA-FORTE';
CREATE DATABASE revsign OWNER revsign;
REVOKE ALL ON DATABASE revsign FROM PUBLIC;
```

3. A URL fica: `postgres://revsign:SENHA-FORTE@<projeto>_<servico-postgres>:5432/revsign`

## Passo 3 — DNS no cPanel

Por quê: o navegador precisa achar o endereço `assinatura-hml.revalle.com.br`.

1. Descubra o IP da VPS no painel da Hostinger (ou no EasyPanel).
2. No cPanel, abra **Zone Editor**.
3. Na linha do domínio `revalle.com.br`, clique em **Manage**.
4. Clique em **Add Record**.
5. **Type**: `A`.
6. **Name**: `assinatura-hml` (o cPanel completa com o domínio).
7. **Address/Record**: o IP da VPS.
8. Clique em **Add Record**.
9. Espere a propagação (de minutos a algumas horas). Teste em https://dnschecker.org digitando `assinatura-hml.revalle.com.br`.

## Passo 4 — Criar o serviço App (RevSign)

1. No projeto, clique em **+ Service** e depois **App**.
2. Em **Service Name**, escreva `revsign`.
3. Clique em **Create**.
4. Na aba **Source**, escolha **Docker Image**.
5. No campo **Image**, escreva `ghcr.io/enzononato/revsign:v2.21.1-revalle.5`.
6. Clique em **Save**.
7. Abra a aba **Environment** (veja o passo 5 antes de salvar).

## Passo 5 — Colocar as variáveis de ambiente (App)

1. Abra `app.env` (do passo 0) no bloco de notas. As variáveis do backup estão em outro arquivo (`backup.env`, passo 7).
2. Troque cada `<preencher>` restante pelo valor real (tabela abaixo, "valor na homologação").
   - `NEXT_PRIVATE_DATABASE_URL` e `NEXT_PRIVATE_DIRECT_DATABASE_URL`: cole a **Internal Connection URL** do passo 2, as duas iguais.
   - `NEXT_PRIVATE_SMTP_*`: veja a seção "SMTP do cPanel" abaixo.
   - `COLABORADORES_DATABASE_URL`: a URL da base de colaboradores (ver `verificacao.md`). Enquanto a base real não existe, troque a linha `NEXT_PRIVATE_REVALLE_IDENTITY_CHECK=required` por `disabled` (só homologação) e apague a linha da URL.
3. No EasyPanel, abra o serviço `revsign` e clique na aba **Environment**.
4. Cole TODO o conteúdo do arquivo na caixa de texto (uma variável por linha, no formato `NOME=valor`, sem aspas).
5. Clique em **Save**.
6. Conferência rápida: o `app.env` não pode ter nenhuma linha com `<preencher>`. Se ainda tiver, o App não sobe direito.
7. Guarde uma cópia do arquivo preenchido no cofre de senhas e apague a cópia solta do computador.

### SMTP do cPanel

Por quê: é o e-mail que envia os convites de assinatura.

1. No cPanel, abra **E-mail Accounts**. Confirme que existe `assinaturas@revalle.com.br` (crie se não existir) e anote a senha.
2. Preencha as variáveis:
   - `NEXT_PRIVATE_SMTP_HOST`: normalmente `mail.revalle.com.br`. Se não conectar, abra **E-mail Accounts → Connect Devices** na conta e use o servidor que o cPanel mostrar.
   - `NEXT_PRIVATE_SMTP_PORT` e `NEXT_PRIVATE_SMTP_SECURE`: use um destes pares:
     - `465` com `true` (recomendado);
     - `587` com `false`.
   - `NEXT_PRIVATE_SMTP_USERNAME`: o e-mail completo, `assinaturas@revalle.com.br`.
   - `NEXT_PRIVATE_SMTP_PASSWORD`: a senha dessa conta de e-mail.
   - `NEXT_PRIVATE_SMTP_FROM_ADDRESS`: `assinaturas@revalle.com.br`.
3. Para os e-mails não caírem no spam: no cPanel, abra **Email Deliverability**, localize `revalle.com.br` e, se aparecer problema em SPF ou DKIM, clique em **Repair** / **Install the suggested record**.

## Passo 6 — Domínio e HTTPS (App)

1. No serviço `revsign`, abra a aba **Domains**.
2. Clique em **Add Domain** (ou **+ Domain**).
3. No campo **Host**, escreva `assinatura-hml.revalle.com.br`.
4. No campo **Port** (porta do app), escreva `3000`.
5. Deixe **HTTPS** ligado (certificado Let's Encrypt automático).
6. Clique em **Save**. Só funciona depois que o DNS do passo 3 propagou.
7. Clique em **Deploy** (botão verde no topo do serviço) e espere o status ficar verde. Na primeira subida o app cria as tabelas sozinho (pode levar 1 a 2 minutos).

## Passo 7 — Serviço de backup

Por quê: copia o banco todo dia, cifrado, para fora da VPS. Detalhes em `backup.md`; crie antes a conta FTP lá descrita (ou deixe `BACKUP_REMOTE_TYPE=none` por enquanto e volte depois). Com `none`, cada backup mostra no log `AVISO: cópia remota desativada` e grava `"remote":"disabled"` e `"warning"` no `last-run.json`, porque os backups ficam só na VPS e não protegem contra a perda do servidor.

1. No projeto, clique em **+ Service** e depois **App**. Nome: `revsign-backup`.
2. Aba **Source** → **Docker Image** → `ghcr.io/enzononato/revsign-backup:v2.21.1-revalle.5` → **Save**.
3. Abra `backup.env` (do passo 0) no bloco de notas e:
   - Troque `BACKUP_DATABASE_URL=<preencher>` pela mesma Internal Connection URL do passo 2.
   - Para a cópia fora da VPS (recomendada), tire o `#` do começo das linhas `BACKUP_REMOTE_*` do exemplo FTPS e preencha host, usuário e senha da conta FTP (veja `backup.md`). Atenção à pasta: se a conta FTP está presa na pasta `revsign-backups`, use `BACKUP_REMOTE_PATH=/`; se vê a pasta pessoal inteira, mantenha `revsign-backups` (senão cria `revsign-backups/revsign-backups`). Deixe `BACKUP_REMOTE_KNOWN_HOSTS_FILE` comentada (só se usa em SFTP).
   - Nenhuma linha SEM `#` pode ficar com `<preencher>`.
4. Aba **Environment** do serviço `revsign-backup`: cole o conteúdo de `backup.env`.
   Clique em **Save**. (`BACKUP_RUN_ON_START` é opcional; veja a tabela.)
5. Aba **Mounts** → **Add Mount** → tipo **Volume**:
   - **Name**: `revsign-backups`
   - **Mount Path**: `/backups`
   - Clique em **Save**. Por quê: a cópia local e o arquivo `last-run.json` ficam guardados mesmo se o serviço reiniciar.
6. Não crie domínio para este serviço (ele não tem site).
7. Clique em **Deploy**.
   Se o log do `revsign-backup` mostrar `ERRO: a pasta /backups não permite gravação`, o mount não é um Volume (ou a permissão está errada): refaça o item 5 com tipo **Volume**.
8. Para testar já, coloque `BACKUP_RUN_ON_START=true`, salve e reinicie. Abra a aba **Logs** e procure `backup concluido`. Depois volte para `false` (ou apague a linha).

## Passo 8 — Criar a conta do administrador

1. Abra `https://assinatura-hml.revalle.com.br` no navegador.
2. Clique em **Criar conta** (Sign up).
3. Preencha com o e-mail `projetos.ti@revalle.com.br`, um nome e uma senha forte.
4. Abra sua caixa de e-mail e clique no link de confirmação.
5. No EasyPanel, abra o serviço `revsign` e clique em **Restart**.
6. Por quê: ao subir, o RevSign promove a ADMIN a conta cujo e-mail é o de `NEXT_PRIVATE_REVALLE_ADMIN_EMAIL`. Isso só acontece na subida. Só contas com o e-mail já confirmado são promovidas; se o log mostrar `conta admin ainda não confirmada`, confirme o e-mail e reinicie. Na mesma subida, ele também ajusta o plano gratuito (usuários, times e documentos ilimitados, sem marca "Powered by"). Isso se repete a CADA reinício: edições manuais nesse plano em Admin → Claims são desfeitas na próxima subida.
   Se um dia trocar `NEXT_PRIVATE_REVALLE_ADMIN_EMAIL`, a conta antiga continua ADMIN; remova o papel dela em Admin → Users.
7. Entre de novo no site e abra `/admin` (`https://assinatura-hml.revalle.com.br/admin`). Se o painel abrir, deu certo.

## Passo 9 — Checagens

1. Abra `https://assinatura-hml.revalle.com.br/api/health`.
   - Esperado: um texto com `"status":"ok"`, `"database":{"status":"ok"}` e `"certificate":{"status":"ok"}`.
   - `warning` no certificado: o certificado não foi lido. Confira as duas variáveis do certificado.
   - `error`: o banco não responde. Confira a `NEXT_PRIVATE_DATABASE_URL`.
2. Abra `https://assinatura-hml.revalle.com.br/api/certificate-status`.
   - Esperado: `"isAvailable":true`.
3. Com o celular no 4G (Wi-Fi desligado), abra o link de um documento de teste e assine. Depois, no site, abra o documento → **Logs** (log de auditoria) e olhe o IP da assinatura.
   - Esperado: o IP público do celular (confira em https://meuip.com.br no mesmo celular).
   - Se aparecer um IP interno (começa com `10.`, `172.` ou `192.168.`), o proxy do EasyPanel não está repassando o IP real. Avise o desenvolvedor.

## Antes de atualizar para esta versão (Fase 3)

Faça estas duas conferências antes de trocar a imagem de uma instalação que já está em uso. Numa instalação nova (sem dados) não há nada a conferir na primeira.

1. **CPF repetido nos vínculos.** A migração `20261029130000_revalle_link_cpf_unique` torna o CPF único na tabela `RevalleEmailLink`. Se houver CPF repetido, ela falha e o app não sobe. Antes de atualizar:
   1. No EasyPanel, abra o serviço do Postgres do RevSign (`revsign-db`) → **Console** e rode `psql -U <usuario> -d <banco>` (usuário e banco da Internal Connection URL; no passo 2 sugerimos `revsign` e `revsign`).
   2. Rode: `SELECT cpf, count(*) FROM "RevalleEmailLink" GROUP BY cpf HAVING count(*) > 1;`
   3. O resultado precisa ser VAZIO. Se aparecer alguma linha, avise o desenvolvedor antes de atualizar. Numa instalação nova a tabela ainda não existe (ou está vazia); não há o que conferir.
2. **IP real no proxy.** O IP que vai para o log de auditoria e para os limites de tentativas vem do cabeçalho `X-Forwarded-For`, preenchido pelo proxy do EasyPanel (Traefik). O proxy precisa SOBRESCREVER o valor que o cliente manda (é o comportamento padrão). Para conferir:
   1. Com o celular no 4G (Wi-Fi desligado), abra o link de um documento de teste e assine (aceite o termo e conclua com o código por e-mail).
   2. No site, abra o documento → **Logs** e olhe o IP dos eventos do termo e do código.
   3. Esperado: o IP público do celular (confira em https://meuip.com.br no mesmo celular).
   4. Se aparecer um IP interno (`10.`, `172.` ou `192.168.`) ou um IP que não é do celular, avise o desenvolvedor: o proxy não está repassando o IP real, e os limites e a auditoria perdem o valor.
   5. **Teste do cabeçalho falso.** Confirme que o proxy não aceita um `X-Forwarded-For` mandado pelo cliente. Num terminal (de qualquer computador), com o link de um documento de teste ainda NÃO assinado (o `<token>` é a parte final do link `/sign/<token>`):
      ```
      curl -s -X POST 'https://assinatura-hml.revalle.com.br/api/trpc/document.accessAuth.request2FAEmail' \
        -H 'Origin: https://assinatura-hml.revalle.com.br' -H 'Content-Type: application/json' \
        -H 'X-Forwarded-For: 1.2.3.4' -d '{"json":{"token":"<token>"}}'
      ```
      Depois, no site, abra o documento → **Logs** e olhe o evento mais recente de pedido de código.
      - Esperado: o IP público do computador que rodou o `curl` (confira em https://meuip.com.br), **nunca** `1.2.3.4`.
      - Se aparecer `1.2.3.4`, PARE e avise o desenvolvedor: qualquer pessoa escolheria o IP gravado na auditoria e fugiria dos limites por IP. O proxy precisa sobrescrever o `X-Forwarded-For`.

Depois de atualizar, preencha as variáveis novas (`COLABORADORES_DATABASE_URL` e, se for o caso, `NEXT_PRIVATE_REVALLE_IDENTITY_CHECK`) conforme `verificacao.md`. O `app.env` gerado pelo script do passo 0 já traz as duas linhas: `NEXT_PRIVATE_REVALLE_IDENTITY_CHECK=required` e `COLABORADORES_DATABASE_URL=<preencher>`. Em instalações já existentes, acrescente-as na aba **Environment**.

## Antes de atualizar para esta versão (Fase 4)

Vale para quem atualiza uma instalação que já está em uso, vinda da Fase 3. Numa instalação nova não há nada a conferir no item 1.

1. **Termine os documentos em andamento.** Antes de trocar a imagem, conclua (ou cancele) os documentos que ainda esperam assinatura. Quem assinou na versão anterior não tem prova congelada, e isso não se corrige depois:
   - no PDF final, essas pessoas não ganham carimbo, e o bloco delas no certificado fica igual ao do Documenso original;
   - o `/verificar`, aberto pelo código de quem assinou depois, lista só quem tem prova; quem assinou antes não aparece;
   - o certificado da primeira selagem sai sem a linha `SHA-256 do original` (ela só aparece numa reselagem).
   Se não der para terminar algum, ele continua válido; só a prova fica parcial.
2. **Backup antes** (passo 7, item 8). As migrações abaixo rodam sozinhas na subida e só ACRESCENTAM tabelas e colunas; nenhuma apaga dados:
   - `20261030100000_revalle_document_hashes` (SHA-256 do original e do PDF selado);
   - `20261030120000_revalle_signature_proof` (prova congelada de cada pessoa);
   - `20261030130000_revalle_signature_kind` (tipo da assinatura visual, preenchido a partir da prova);
   - `20261030140000_revalle_sealed_hashes` (histórico das versões seladas: a reselagem acrescenta uma versão e as cópias antigas continuam conferindo no `/verificar`).
3. **Variáveis novas.** Nenhuma precisa ser definida; os padrões valem. Ver a tabela abaixo:
   - `NEXT_PRIVATE_REVALLE_ICP_SEAL`: a selagem ICP-Brasil (política AD-RB e DocMDP) fica **ligada por padrão** a partir desta versão (`certificado.md`);
   - `NEXT_PRIVATE_REVALLE_ICP_PDF_DICT` e `NEXT_PRIVATE_REVALLE_ICP_POLICY_HASH`: só se o validar.iti.gov.br reclamar;
   - `NEXT_PRIVATE_REVALLE_GEOIP_DB_PATH`: caminho da base de geolocalização por IP; só para usar outro arquivo.
4. **Base de geolocalização por IP (DB-IP).** A base vem DENTRO da imagem, baixada do db-ip.com no build. O workflow de publicação falha se o download não deu certo (rode-o de novo mais tarde), então uma imagem publicada sempre tem a base. A base fica congelada até a próxima imagem. Depois de atualizar:
   1. No EasyPanel, abra o serviço `revsign` → **Logs** e procure, logo depois da subida, a linha `base de geolocalização por IP carregada` com a data da base (`buildDate`).
   2. Se aparecer `geolocalização por IP indisponível`, a base está ausente ou vazia: as assinaturas funcionam, mas o certificado mostra `não identificada` em "Localização aproximada (IP)". Avise o desenvolvedor.
   3. (Opcional) Teste direto, no **Console** do serviço `revsign`: `cd /app && node -e "require('maxmind').open('/app/geoip/dbip-city-lite.mmdb').then((r) => console.log(r.get('8.8.8.8')?.country?.iso_code, r.metadata.buildEpoch))"`. Esperado: `US` e a data da base.
5. **Selagem.** Assine um documento de teste e confira o PDF final como em `certificado.md` (painel de assinaturas do leitor de PDF ou `scripts/revalle/inspect-pdf-signature.sh`).

## Tabela de todas as variáveis

Legenda de "segredo?": **sim** = nunca no repositório, só no EasyPanel e no cofre.

### Serviço App (`revsign`)

| Nome | Para que serve | Valor na homologação | Segredo? |
|---|---|---|---|
| `PORT` | Porta do app dentro do container | `3000` | não |
| `NODE_ENV` | Modo de produção (evita mostrar detalhes de erro) | `production` | não |
| `TZ` | Fuso horário (horas no certificado e no log) | `America/Bahia` | não |
| `NEXT_PRIVATE_INTERNAL_WEBAPP_URL` | Endereço do app para ele mesmo | `http://localhost:3000` | não |
| `NEXT_PUBLIC_UPLOAD_TRANSPORT` | Onde guardar os PDFs (no banco) | `database` | não |
| `NEXT_PRIVATE_JOBS_PROVIDER` | Fila de tarefas interna | `local` | não |
| `NEXT_PRIVATE_SMTP_TRANSPORT` | Tipo de envio de e-mail | `smtp-auth` | não |
| `NEXT_PRIVATE_SIGNING_TRANSPORT` | Onde fica o certificado de assinatura | `local` | não |
| `DOCUMENSO_DISABLE_TELEMETRY` | Desliga o envio de estatísticas ao upstream | `true` | não |
| `NEXT_PUBLIC_REVALLE_SOURCE_URL` | Link "Código-fonte" no rodapé (exigência da AGPL) | `https://github.com/enzononato/RevSign` | não |
| `NEXT_PRIVATE_ALLOWED_SIGNUP_DOMAINS` | Só e-mails destes domínios podem se cadastrar | `revalle.com.br,revallenordeste.com.br,revallepe.com.br` | não |
| `NEXT_PRIVATE_REVALLE_RATE_LIMITS` | (Opcional) muda limites de tentativas. Sem ela valem os padrões do RevSign (cadastro, login, código por e-mail etc.; tabela em `verificacao.md`) | não definir | não |
| `NEXT_PRIVATE_REVALLE_ADMIN_EMAIL` | Conta promovida a ADMIN quando o app sobe | `projetos.ti@revalle.com.br` | não |
| `NEXT_PRIVATE_REVALLE_IDENTITY_CHECK` | Confere CPF e data de nascimento na base de colaboradores na primeira assinatura. `required` (padrão) ou `disabled` (pula a etapa; só homologação sem a base, nunca em produção) | não definir (vale `required`) ou `disabled` enquanto não houver base | não |
| `COLABORADORES_DATABASE_URL` | Conexão SÓ DE LEITURA com a view `vw_colaboradores_assinatura` da base de colaboradores (`postgres://revsign_leitura:<senha>@<host>:5432/<banco>`; ver `verificacao.md`) | URL da base real, ou da base fictícia de ensaio | sim |
| `NEXT_PRIVATE_DATABASE_URL` | Conexão com o banco | Internal Connection URL do passo 2 | sim |
| `NEXT_PRIVATE_DIRECT_DATABASE_URL` | Conexão direta com o banco (igual à anterior) | o mesmo valor | sim |
| `NEXT_PUBLIC_WEBAPP_URL` | Endereço público do site (links dos e-mails). A linha 5 do carimbo ("Confira em …/verificar") usa o valor no momento da selagem: trocar o endereço depois só muda PDFs selados ou reselados a partir daí | `https://assinatura-hml.revalle.com.br` | não |
| `NEXTAUTH_SECRET` | Protege o login | gerado pelo script | sim |
| `NEXT_PRIVATE_ENCRYPTION_KEY` | Cifra dados sensíveis no banco | gerado pelo script | sim |
| `NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY` | Segunda chave de cifra | gerado pelo script | sim |
| `NEXT_PUBLIC_DISABLE_SIGNUP` | Liga/desliga o cadastro (a restrição real é por domínio) | `false` | não |
| `NEXT_PRIVATE_SMTP_HOST` | Servidor de e-mail | `mail.revalle.com.br` | não |
| `NEXT_PRIVATE_SMTP_PORT` | Porta do e-mail | `465` (ou `587`) | não |
| `NEXT_PRIVATE_SMTP_SECURE` | `true` para a porta 465, `false` para a 587 | `true` (ou `false`) | não |
| `NEXT_PRIVATE_SMTP_USERNAME` | Usuário do e-mail (endereço completo) | `assinaturas@revalle.com.br` | não |
| `NEXT_PRIVATE_SMTP_PASSWORD` | Senha da conta de e-mail | senha da conta no cPanel | sim |
| `NEXT_PRIVATE_SMTP_FROM_NAME` | Nome do remetente | `Revalle Assinaturas` | não |
| `NEXT_PRIVATE_SMTP_FROM_ADDRESS` | Endereço do remetente | `assinaturas@revalle.com.br` | não |
| `NEXT_PRIVATE_SIGNING_LOCAL_FILE_CONTENTS` | Certificado `.p12` em base64 (uma linha) | gerado pelo script | sim |
| `NEXT_PRIVATE_SIGNING_PASSPHRASE` | Senha do certificado | gerada pelo script | sim |
| `NEXT_PRIVATE_REVALLE_ICP_SEAL` | Selagem ICP-Brasil: política AD-RB nos atributos assinados e DocMDP P=2 (ver `certificado.md`). `false` volta à selagem do upstream. `NEXT_PRIVATE_USE_LEGACY_SIGNING_SUBFILTER=true` também a desliga | não definir (vale `true`) | não |
| `NEXT_PRIVATE_REVALLE_ICP_PDF_DICT` | Nomes no dicionário da assinatura: `etsi` (padrão: `Adobe.PPKLite` / `ETSI.CAdES.detached`) ou `pbad` (`PBAD_PAdES` / `PBAD.PAdES`, como a política escreve). Só troque se o validar.iti.gov.br reclamar do dicionário (ver `certificado.md`) | não definir (vale `etsi`) | não |
| `NEXT_PRIVATE_REVALLE_ICP_POLICY_HASH` | Hash da política no atributo assinado: `policy` (padrão: o hash ETSI que o arquivo da política traz) ou `lpa` (SHA-256 do arquivo, como na LPA). Só troque se o validar.iti.gov.br acusar hash da política diferente (ver `certificado.md`) | não definir (vale `policy`) | não |
| `NEXT_PRIVATE_REVALLE_GEOIP_DB_PATH` | (Opcional) caminho da base DB-IP Lite City (`.mmdb`) usada para a "Localização aproximada (IP)" do certificado. A imagem já traz a base em `/app/geoip/dbip-city-lite.mmdb`, baixada no build e congelada até a próxima imagem (a DB-IP publica uma base por mês). Só defina para usar outro arquivo (ex.: um volume montado com uma base mais nova). Base ausente ou vazia: o app funciona, o log mostra um aviso na subida e o certificado diz `não identificada` | não definir (vale `/app/geoip/dbip-city-lite.mmdb`) | não |

### Serviço Postgres (`revsign-db`)

| Nome | Para que serve | Valor na homologação | Segredo? |
|---|---|---|---|
| `POSTGRES_PASSWORD` | Senha do usuário do banco (campo Password do serviço Postgres) | gerada por você (`openssl rand -hex 32`) | sim |

### Serviço de backup (`revsign-backup`)

| Nome | Para que serve | Valor na homologação | Segredo? |
|---|---|---|---|
| `BACKUP_DATABASE_URL` | Banco que será copiado | a mesma Internal Connection URL | sim |
| `BACKUP_AGE_RECIPIENT` | Chave PÚBLICA que cifra os backups (sem ela o serviço não sobe) | `age1...` gerada pelo script | não (é pública) |
| `BACKUP_CRON` | Horário do backup (formato cron) | padrão `0 2 * * *` (todo dia às 02:00) | não |
| `BACKUP_RETENTION_DAYS` | Quantos dias de cópias guardar | padrão `30` | não |
| `BACKUP_RUN_ON_START` | Faz um backup assim que o serviço sobe | padrão `false` | não |
| `BACKUP_REMOTE_TYPE` | Tipo de cópia externa: `none`, `sftp` ou `ftps` | `ftps` | não |
| `BACKUP_REMOTE_HOST` | Servidor da hospedagem | host da conta FTP no cPanel | não |
| `BACKUP_REMOTE_PORT` | Porta do servidor | `21` (ftps) ou a porta do SSH (sftp) | não |
| `BACKUP_REMOTE_USER` | Usuário da conta FTP/SFTP | usuário criado no cPanel | não |
| `BACKUP_REMOTE_PASSWORD` | Senha da conta FTP/SFTP | senha da conta | sim |
| `BACKUP_REMOTE_PATH` | Pasta de destino na hospedagem | `revsign-backups` | não |
| `BACKUP_REMOTE_KNOWN_HOSTS_FILE` | Só SFTP com arquivo `known_hosts` montado: caminho dele (`/known_hosts`). No FTPS, deixe a linha comentada | (comentada) | não |
| `BACKUP_REMOTE_INSECURE_TLS` | (Só testes) aceita certificado FTPS inválido | não definir (padrão `false`) | não |

Variáveis só do ensaio local (não use no EasyPanel): `REVSIGN_IMAGE`, `REVSIGN_BACKUP_IMAGE`.

## Atualizar a versão depois

0. Antes de trocar a versão, confirme que as DUAS imagens existem para a tag nova: `ghcr.io/enzononato/revsign:<tag>` e `ghcr.io/enzononato/revsign-backup:<tag>` (GitHub → Packages; os dois jobs de publicação são independentes e um pode falhar sozinho).
1. Em **Source**, troque o número da versão na imagem (`...:v2.21.1-revalle.N`).
2. Clique em **Deploy**.
3. Rode as checagens do passo 9. Faça o backup antes (passo 7, item 8).
