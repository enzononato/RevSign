#!/bin/sh
# Valida a configuração, agenda o backup (supercronic) e mantém o container vivo.
set -eu
. /usr/local/lib/revsign/common.sh

: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL obrigatoria}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT obrigatoria (chave publica age1...)}"
setup_remote

CRON="${BACKUP_CRON:-0 2 * * *}"
printf '%s /usr/local/bin/backup.sh\n' "$CRON" >/tmp/crontab
echo "agendado: $CRON (TZ=${TZ:-})"

if [ "${BACKUP_RUN_ON_START:-false}" = true ]; then
  /usr/local/bin/backup.sh || echo "backup inicial falhou (veja /backups/last-run.json)" >&2
fi

exec supercronic /tmp/crontab
