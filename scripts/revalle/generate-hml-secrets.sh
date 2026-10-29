#!/usr/bin/env bash
# RevSign: gera os segredos da homologação numa pasta FORA do repositório.
# Uso: generate-hml-secrets.sh <pasta-de-saida>
set -euo pipefail
umask 077

OUT="${1:-}"
if [ -z "$OUT" ]; then
  echo "Uso: $0 <pasta-de-saida-fora-do-repositorio>" >&2
  exit 1
fi

command -v git >/dev/null || { echo "ERRO: falta o comando git (necessário para checar a pasta)." >&2; exit 1; }

# Caminho absoluto, sem criar nada ainda.
# Normaliza (resolve .. e links) antes de qualquer checagem.
OUT="$(realpath -m -- "$OUT")"

# Recusa link simbólico (inclusive quebrado) no destino final.
if [ -L "$OUT" ] || [ -L "${1%/}" ]; then
  echo "ERRO: $1 é um link simbólico. Indique uma pasta de verdade." >&2
  exit 1
fi

if [ -e "$OUT" ] && [ ! -d "$OUT" ]; then
  echo "ERRO: $OUT existe e não é uma pasta." >&2
  exit 1
fi

# Ancestral existente mais próximo (a pasta em si, se já existir).
ANC="$OUT"
while [ ! -d "$ANC" ]; do ANC="$(dirname "$ANC")"; done
ANC="$(cd "$ANC" && pwd -P)"

# Recusa pasta dentro de um repositório Git (falha fechada se o git der erro).
if GIT_ERR="$(LC_ALL=C git -C "$ANC" rev-parse --show-toplevel 2>&1)"; then
  echo "ERRO: $OUT está dentro do repositório Git ($GIT_ERR). Escolha uma pasta fora dele." >&2
  exit 1
elif ! printf '%s' "$GIT_ERR" | grep -qi 'not a git repository'; then
  echo "ERRO: não consegui checar se a pasta está em um repositório Git: $GIT_ERR" >&2
  exit 1
fi

# Recusa pasta que já tenha arquivos.
if [ -d "$OUT" ] && [ -n "$(ls -A "$OUT")" ]; then
  echo "ERRO: $OUT já tem arquivos. Use uma pasta vazia (nada foi sobrescrito)." >&2
  exit 1
fi

# Em caso de falha, remove só o que esta execução criou.
CREATED_TOP=""
if [ ! -d "$OUT" ]; then
  CREATED_TOP="$OUT"
  while [ ! -d "$(dirname "$CREATED_TOP")" ]; do CREATED_TOP="$(dirname "$CREATED_TOP")"; done
fi
cleanup() {
  rc=$?
  if [ "$rc" -ne 0 ]; then
    if [ -n "$CREATED_TOP" ]; then
      rm -rf -- "$CREATED_TOP"
    else
      find "$OUT" -mindepth 1 -delete 2>/dev/null || true # pasta estava vazia antes
    fi
    echo "Falhou: nada foi deixado em $OUT." >&2
  fi
}
trap cleanup EXIT
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd -P)"

for cmd in openssl base64; do
  command -v "$cmd" >/dev/null || { echo "ERRO: falta o comando $cmd." >&2; exit 1; }
done

# age-keygen: local ou via Docker.
gen_age() { # $1 = arquivo de saída
  if command -v age-keygen >/dev/null; then
    age-keygen -o "$1" 2>/dev/null
  elif command -v docker >/dev/null; then
    if [ -n "${REVSIGN_BACKUP_IMAGE:-}" ]; then
      docker run --rm --entrypoint age-keygen "$REVSIGN_BACKUP_IMAGE" >"$1" 2>/dev/null
    else
      docker run --rm alpine:3.22 sh -c 'apk add -q age >/dev/null && age-keygen 2>/dev/null' >"$1"
    fi
  else
    echo "ERRO: precisa de age-keygen ou Docker." >&2
    exit 1
  fi
}

mkdir -p "$OUT/cert"

# Certificado autoassinado (homologação).
openssl rand -hex 24 | tr -d '\n' >"$OUT/cert/passphrase.txt"
openssl req -x509 -newkey rsa:3072 -nodes -days 365 -sha256 \
  -subj "/C=BR/O=Revalle/CN=RevSign Homologacao" \
  -keyout "$OUT/cert/.key.pem" -out "$OUT/cert/.cert.pem" 2>/dev/null
openssl pkcs12 -export -inkey "$OUT/cert/.key.pem" -in "$OUT/cert/.cert.pem" \
  -out "$OUT/cert/cert.p12" -passout "file:$OUT/cert/passphrase.txt" \
  -keypbe AES-256-CBC -certpbe AES-256-CBC -macalg sha256
rm -f "$OUT/cert/.key.pem" "$OUT/cert/.cert.pem"

# Chave de backup (age). A privada fica só com o Enzo.
gen_age "$OUT/backup-age-identity.txt"
AGE_PUB="$(grep -o 'age1[a-z0-9]*' "$OUT/backup-age-identity.txt" | head -n1)"
[ -n "$AGE_PUB" ] || { echo "ERRO: não consegui gerar a chave age." >&2; exit 1; }

P12_B64="$(base64 -w0 "$OUT/cert/cert.p12")"
PASS="$(cat "$OUT/cert/passphrase.txt")"

cat >"$OUT/app.env" <<ENV
# RevSign — homologação, serviço APP. Cole TUDO na aba Environment do serviço "revsign" no EasyPanel.
# Troque cada <preencher> pelo valor real antes de salvar.

# --- Valores fixos ---
PORT=3000
NODE_ENV=production
TZ=America/Bahia
NEXT_PRIVATE_INTERNAL_WEBAPP_URL=http://localhost:3000
NEXT_PUBLIC_UPLOAD_TRANSPORT=database
NEXT_PRIVATE_JOBS_PROVIDER=local
NEXT_PRIVATE_SMTP_TRANSPORT=smtp-auth
NEXT_PRIVATE_SIGNING_TRANSPORT=local
DOCUMENSO_DISABLE_TELEMETRY=true
NEXT_PUBLIC_REVALLE_SOURCE_URL=https://github.com/enzononato/RevSign
# Cadastro só destes domínios, separados por vírgula.
NEXT_PRIVATE_ALLOWED_SIGNUP_DOMAINS=revalle.com.br,revallenordeste.com.br,revallepe.com.br
# Administrador principal: promovido a ADMIN na subida, se já cadastrado.
NEXT_PRIVATE_REVALLE_ADMIN_EMAIL=projetos.ti@revalle.com.br

# --- Base de colaboradores (verificação de identidade) ---
# required (padrão): confere CPF + data de nascimento na base. "disabled" só em homologação sem base
# (a etapa é pulada e registrada como não verificado); nesse caso apague a linha COLABORADORES_DATABASE_URL.
NEXT_PRIVATE_REVALLE_IDENTITY_CHECK=required
# Só leitura, só a view vw_colaboradores_assinatura. Formato: postgres://revsign_leitura:<senha>@<host>:5432/<banco>
COLABORADORES_DATABASE_URL=<preencher>

# --- Banco (serviço Postgres dedicado no EasyPanel) ---
# Formato: postgres://revsign:<senha>@<host-interno>:5432/revsign
# O host interno é o nome do serviço Postgres no EasyPanel (<projeto>_<servico-postgres>).
NEXT_PRIVATE_DATABASE_URL=<preencher>
NEXT_PRIVATE_DIRECT_DATABASE_URL=<preencher>

# --- Marca ---
NEXT_PRIVATE_SIGNING_REASON=Selado pelo RevSign da Revalle
NEXT_PUBLIC_SUPPORT_EMAIL=projetos.ti@revalle.com.br

# --- App ---
NEXT_PUBLIC_WEBAPP_URL=https://assinatura-hml.revalle.com.br
NEXTAUTH_SECRET=$(openssl rand -hex 32)
NEXT_PRIVATE_ENCRYPTION_KEY=$(openssl rand -hex 32)
NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY=$(openssl rand -hex 32)
# Cadastro aberto: a restrição é feita por NEXT_PRIVATE_ALLOWED_SIGNUP_DOMAINS.
NEXT_PUBLIC_DISABLE_SIGNUP=false

# --- SMTP do cPanel ---
# Porta 465 => SECURE=true (TLS direto). Porta 587 => SECURE=false (STARTTLS).
# Usuário = e-mail completo da conta (ex.: assinaturas@revalle.com.br).
NEXT_PRIVATE_SMTP_HOST=<preencher>
NEXT_PRIVATE_SMTP_PORT=<preencher>
NEXT_PRIVATE_SMTP_SECURE=<preencher>
NEXT_PRIVATE_SMTP_USERNAME=<preencher>
NEXT_PRIVATE_SMTP_PASSWORD=<preencher>
NEXT_PRIVATE_SMTP_FROM_NAME=RevSign
NEXT_PRIVATE_SMTP_FROM_ADDRESS=assinaturas@revalle.com.br

# --- Certificado de assinatura ---
NEXT_PRIVATE_SIGNING_LOCAL_FILE_CONTENTS=$P12_B64
NEXT_PRIVATE_SIGNING_PASSPHRASE=$PASS
ENV

cat >"$OUT/backup.env" <<ENV
# RevSign — homologação, serviço BACKUP. Cole na aba Environment do serviço "revsign-backup".
# Linhas começadas por # são comentários: tire o # só das que for usar.

# Mesmo banco do app. Formato: postgres://revsign:<senha>@<host-interno>:5432/revsign
# (é a "Internal Connection URL" do serviço Postgres no EasyPanel).
BACKUP_DATABASE_URL=<preencher>

# Chave PÚBLICA (a privada é o arquivo backup-age-identity.txt, que não vai para a VPS).
BACKUP_AGE_RECIPIENT=$AGE_PUB
TZ=America/Bahia
# Guarda um arquivo por dia dos últimos 30 dias.
BACKUP_RETENTION_DAYS=30
# Todo dia às 02:00.
BACKUP_CRON=0 2 * * *

# --- Cópia remota (fora da VPS). Sem estas linhas, o backup fica só na VPS. ---
# Exemplo FTPS (conta FTP do cPanel presa à pasta revsign-backups). Tire o # e preencha:
# BACKUP_REMOTE_TYPE=ftps
# BACKUP_REMOTE_HOST=<preencher>
# BACKUP_REMOTE_PORT=21
# BACKUP_REMOTE_USER=<preencher>
# BACKUP_REMOTE_PASSWORD=<preencher>
# BACKUP_REMOTE_PATH=revsign-backups
#
# Alternativa SFTP (só se a hospedagem tiver SSH): BACKUP_REMOTE_TYPE=sftp e a porta do SSH.
# Só no SFTP, e só se você montou um arquivo known_hosts no container (ver backup.md):
# BACKUP_REMOTE_KNOWN_HOSTS_FILE=/known_hosts
ENV

cat >"$OUT/LEIA-ME.txt" <<'TXT'
SEGREDOS DA HOMOLOGAÇÃO DO REVSIGN
==================================

Esta pasta tem segredos. Não mande por e-mail nem por WhatsApp.
Não coloque dentro do repositório Git.

O que cada arquivo é e para onde vai:

1. app.env  (serviço do site, "revsign")
   - Abra o arquivo, troque cada <preencher> pelo valor real.
   - COLABORADORES_DATABASE_URL: ver revalle/docs/verificacao.md. Sem a base real ainda, use
     NEXT_PRIVATE_REVALLE_IDENTITY_CHECK=disabled (só homologação) e apague essa linha.
   - Cole o conteúdo na aba "Environment" do serviço no EasyPanel.
   - Depois de colar, guarde uma cópia no cofre de senhas e apague a cópia solta.

1b. backup.env  (serviço "revsign-backup")
   - Preencha BACKUP_DATABASE_URL (mesmo banco do app).
   - Para a cópia fora da VPS, tire o # das linhas BACKUP_REMOTE_* e preencha.
   - Cole na aba "Environment" do serviço de backup.

2. backup-age-identity.txt
   - É a chave PRIVADA dos backups. Sem ela, os backups não abrem.
   - Guarde no cofre de senhas, fora da VPS. Nunca coloque no EasyPanel.

3. cert/ (cert.p12 e passphrase.txt)
   - É o certificado de assinatura e a senha dele.
   - Guarde no cofre de senhas, fora da VPS.
   - O conteúdo do certificado já está dentro do app.env.
   - Validade: 365 dias.
TXT

chmod 600 "$OUT/app.env" "$OUT/backup.env" "$OUT/backup-age-identity.txt" "$OUT/LEIA-ME.txt" "$OUT/cert/"*
chmod 700 "$OUT/cert"
echo "Pronto. Arquivos gerados em: $OUT"
echo "Leia o LEIA-ME.txt desta pasta."
