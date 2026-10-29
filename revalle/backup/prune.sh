#!/bin/sh
# Apaga revsign-*.dump.age mais velhos que BACKUP_RETENTION_DAYS, local e remoto.
# Em cada lado, o arquivo mais novo é SEMPRE preservado.
set -eu
. /usr/local/lib/revsign/common.sh

DAYS="${BACKUP_RETENTION_DAYS:-30}"
case "$DAYS" in ''|*[!0-9]*) echo "BACKUP_RETENTION_DAYS inválido" >&2; exit 1 ;; esac

prune_side() {
  base="$1"
  all="$(rclone lsf --format tp --files-only --include "$PATTERN" "$base")"
  [ -n "$all" ] || return 0
  newest="$(printf '%s\n' "$all" | sort | tail -n 1 | cut -d';' -f2-)"
  old="$(rclone lsf --files-only --include "$PATTERN" --min-age "${DAYS}d" "$base")"
  [ -n "$old" ] || return 0
  printf '%s\n' "$old" | while IFS= read -r f; do
    [ "$f" = "$newest" ] && continue
    rclone deletefile "$base/$f"
    echo "removido: $base/$f"
  done
}

prune_side "$BACKUP_DIR"

if [ "${BACKUP_REMOTE_TYPE:-none}" != none ]; then
  setup_remote
  prune_side "$(remote_base)"
fi
