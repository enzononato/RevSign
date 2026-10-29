#!/bin/sh
# Backup: pg_dump -Fc | age -> /backups, cópia remota, retenção, last-run.json.
# O dump em texto puro nunca toca o disco. Sem BACKUP_AGE_RECIPIENT, nada roda.
set -eu
. /usr/local/lib/revsign/common.sh

STATUS="$BACKUP_DIR/last-run.json"
FILE=""
REMOTE=""   # "", "ok" ou "disabled"
WARNING=""

write_status() { # status mensagem
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  extra=""
  [ -z "$REMOTE" ] || extra="$extra,\"remote\":\"$REMOTE\""
  [ -z "$WARNING" ] || extra="$extra,\"warning\":\"$WARNING\""
  printf '{"status":"%s","finishedAt":"%s","file":"%s","message":"%s"%s}\n' \
    "$1" "$now" "$FILE" "$2" "$extra" >"$STATUS.tmp" 2>/dev/null && mv "$STATUS.tmp" "$STATUS" || true
}

fail() {
  echo "ERRO: $1" >&2
  write_status error "$1"
  exit 1
}

[ -n "${BACKUP_AGE_RECIPIENT:-}" ] || fail "BACKUP_AGE_RECIPIENT ausente: backup nao executado"
[ -n "${BACKUP_DATABASE_URL:-}" ] || fail "BACKUP_DATABASE_URL ausente: backup nao executado"
setup_remote || fail "configuracao do destino remoto invalida"

mkdir -p "$BACKUP_DIR"
NAME="revsign-$(date +%Y%m%d-%H%M%S).dump.age"
FILE="$BACKUP_DIR/$NAME"
TMPF="$FILE.tmp"
RCF="$BACKUP_DIR/.pgdump-rc.$$"
trap 'rm -f "$TMPF" "$RCF"' EXIT

# O código de saída do pg_dump vai a um arquivo pequeno, porque o do pipeline é o do age.
if ! { pg_dump -Fc "$BACKUP_DATABASE_URL"; echo "$?" >"$RCF"; } | age -r "$BACKUP_AGE_RECIPIENT" >"$TMPF"; then
  fail "falha ao cifrar o dump (chave age valida?)"
fi
[ "$(cat "$RCF" 2>/dev/null || echo 1)" = 0 ] || fail "pg_dump falhou"
mv "$TMPF" "$FILE"
echo "dump cifrado: $NAME"

if [ "${BACKUP_REMOTE_TYPE:-none}" != none ]; then
  if ! rclone copy "$FILE" "$(remote_base)" --retries 1 --low-level-retries 2 \
    --contimeout 20s --timeout 120s; then
    # Falha remota: ainda aplica a retenção LOCAL (mantém sempre o mais novo, o de hoje),
    # para o disco da VPS não encher; o remoto nunca é tocado.
    /usr/local/bin/prune.sh local || true
    REMOTE=failed
    fail "falha ao copiar para o destino remoto (dump local mantido)"
  fi
  REMOTE=ok
  echo "copiado para o destino remoto"
else
  REMOTE=disabled
  WARNING="copia remota desativada (BACKUP_REMOTE_TYPE=none): os backups estao so na VPS"
  echo "AVISO: cópia remota desativada (BACKUP_REMOTE_TYPE=none) — os backups estão só na VPS."
fi

/usr/local/bin/prune.sh both || fail "backup feito, mas a retencao falhou"

write_status ok "backup concluido"
echo "backup concluido"
