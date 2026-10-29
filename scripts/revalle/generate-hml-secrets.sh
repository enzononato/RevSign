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

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

# Recusa pasta dentro de um repositório Git.
if REPO="$(cd "$OUT" && git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "ERRO: $OUT está dentro do repositório Git ($REPO). Escolha uma pasta fora dele." >&2
  exit 1
fi

# Recusa pasta que já tenha arquivos.
if [ -n "$(ls -A "$OUT")" ]; then
  echo "ERRO: $OUT já tem arquivos. Use uma pasta vazia (nada foi sobrescrito)." >&2
  exit 1
fi

for cmd in openssl base64; do
  command -v "$cmd" >/dev/null || { echo "ERRO: falta o comando $cmd." >&2; exit 1; }
done

# age-keygen: local ou via Docker.
gen_age() { # $1 = arquivo de saída
  if command -v age-keygen >/dev/null; then
    age-keygen -o "$1" 2>/dev/null
  elif command -v docker >/dev/null; then
    docker run --rm --entrypoint age-keygen "${REVSIGN_BACKUP_IMAGE:-alpine:3.22}" >"$1" 2>/dev/null \
      || docker run --rm alpine:3.22 sh -c 'apk add -q age >/dev/null && age-keygen 2>/dev/null' >"$1"
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

cat >"$OUT/easypanel.env" <<ENV
# RevSign — homologação. Cole TUDO na aba Environment do serviço no EasyPanel.
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

# --- Banco (serviço Postgres dedicado no EasyPanel) ---
# Formato: postgres://revsign:<senha>@<host-interno>:5432/revsign
# O host interno é o nome do serviço Postgres no EasyPanel (<projeto>_<servico-postgres>).
NEXT_PRIVATE_DATABASE_URL=<preencher>
NEXT_PRIVATE_DIRECT_DATABASE_URL=<preencher>

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
NEXT_PRIVATE_SMTP_FROM_NAME=Revalle Assinaturas
NEXT_PRIVATE_SMTP_FROM_ADDRESS=assinaturas@revalle.com.br

# --- Certificado de assinatura ---
NEXT_PRIVATE_SIGNING_LOCAL_FILE_CONTENTS=$P12_B64
NEXT_PRIVATE_SIGNING_PASSPHRASE=$PASS

# --- Backup diário (chave PÚBLICA; a privada é o arquivo backup-age-identity.txt) ---
BACKUP_AGE_RECIPIENT=$AGE_PUB
# Cópia remota: none | sftp | ftps
BACKUP_REMOTE_TYPE=<preencher>
BACKUP_REMOTE_HOST=<preencher>
BACKUP_REMOTE_PORT=<preencher>
BACKUP_REMOTE_USER=<preencher>
BACKUP_REMOTE_PASSWORD=<preencher>
BACKUP_REMOTE_PATH=revsign-backups
# SFTP: arquivo known_hosts montado no container (verifica a chave do servidor).
BACKUP_REMOTE_KNOWN_HOSTS_FILE=<preencher>
ENV

cat >"$OUT/LEIA-ME.txt" <<'TXT'
SEGREDOS DA HOMOLOGAÇÃO DO REVSIGN
==================================

Esta pasta tem segredos. Não mande por e-mail nem por WhatsApp.
Não coloque dentro do repositório Git.

O que cada arquivo é e para onde vai:

1. easypanel.env
   - Abra o arquivo, troque cada <preencher> pelo valor real.
   - Cole o conteúdo na aba "Environment" do serviço no EasyPanel.
   - Depois de colar, guarde uma cópia no cofre de senhas e apague a cópia solta.

2. backup-age-identity.txt
   - É a chave PRIVADA dos backups. Sem ela, os backups não abrem.
   - Guarde no cofre de senhas, fora da VPS. Nunca coloque no EasyPanel.

3. cert/ (cert.p12 e passphrase.txt)
   - É o certificado de assinatura e a senha dele.
   - Guarde no cofre de senhas, fora da VPS.
   - O conteúdo do certificado já está dentro do easypanel.env.
   - Validade: 365 dias.
TXT

chmod 600 "$OUT/easypanel.env" "$OUT/backup-age-identity.txt" "$OUT/LEIA-ME.txt" "$OUT/cert/"*
chmod 700 "$OUT/cert"
echo "Pronto. Arquivos gerados em: $OUT"
echo "Leia o LEIA-ME.txt desta pasta."
