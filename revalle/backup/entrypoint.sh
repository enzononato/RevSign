#!/bin/sh
# Valida a configuração, agenda o backup (supercronic) e mantém o container vivo.
set -eu
. /usr/local/lib/revsign/common.sh

: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL obrigatoria}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT obrigatoria (chave publica age1...)}"
setup_remote

# A pasta de backups precisa aceitar gravação pelo usuário do container (UID 1001).
mkdir -p "$BACKUP_DIR" 2>/dev/null || true
probe="$BACKUP_DIR/.gravacao-teste.$$"
if ! ( : >"$probe" ) 2>/dev/null; then
  echo "ERRO: a pasta $BACKUP_DIR não permite gravação pelo usuário do backup (UID $(id -u)). No EasyPanel, use um Volume (não um bind de pasta do host) ou ajuste a permissão." >&2
  exit 1
fi
rm -f "$probe"

if [ "${BACKUP_REMOTE_TYPE:-none}" = none ]; then
  echo "AVISO: cópia remota desativada (BACKUP_REMOTE_TYPE=none) — os backups estão só na VPS." >&2
fi

CRON="${BACKUP_CRON:-0 2 * * *}"
printf '%s /usr/local/bin/backup.sh\n' "$CRON" >/tmp/crontab
echo "agendado: $CRON (TZ=${TZ:-})"

if [ "${BACKUP_RUN_ON_START:-false}" = true ]; then
  /usr/local/bin/backup.sh || echo "backup inicial falhou (veja /backups/last-run.json)" >&2
fi

exec supercronic /tmp/crontab
