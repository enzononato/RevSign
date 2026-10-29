#!/bin/sh
# Funções comuns (usar com ". common.sh"). Nunca imprime senhas.

BACKUP_DIR="${BACKUP_DIR:-/backups}"
PATTERN='revsign-*.dump.age'

# Monta o remote "remote" do rclone só em variáveis de ambiente (nada vai a disco
# nem à linha de comando). Sem remoto (type=none) não faz nada.
#
# BACKUP_REMOTE_INSECURE_TLS=true (padrão false): aceita certificado FTPS
# autoassinado. Existe só para os testes; em produção deixe false.
setup_remote() {
  type="${BACKUP_REMOTE_TYPE:-none}"
  [ "$type" = none ] && return 0

  : "${BACKUP_REMOTE_HOST:?BACKUP_REMOTE_HOST obrigatória}"
  : "${BACKUP_REMOTE_USER:?BACKUP_REMOTE_USER obrigatória}"
  : "${BACKUP_REMOTE_PASSWORD:?BACKUP_REMOTE_PASSWORD obrigatória}"

  case "$type" in
    sftp)
      export RCLONE_CONFIG_REMOTE_TYPE=sftp
      export RCLONE_CONFIG_REMOTE_PORT="${BACKUP_REMOTE_PORT:-22}"
      ;;
    ftps)
      export RCLONE_CONFIG_REMOTE_TYPE=ftp
      export RCLONE_CONFIG_REMOTE_PORT="${BACKUP_REMOTE_PORT:-21}"
      export RCLONE_CONFIG_REMOTE_EXPLICIT_TLS=true
      if [ "${BACKUP_REMOTE_INSECURE_TLS:-false}" = true ]; then
        export RCLONE_CONFIG_REMOTE_NO_CHECK_CERTIFICATE=true
      fi
      ;;
    *)
      echo "BACKUP_REMOTE_TYPE inválido (use sftp, ftps ou none)" >&2
      return 1
      ;;
  esac

  export RCLONE_CONFIG_REMOTE_HOST="$BACKUP_REMOTE_HOST"
  export RCLONE_CONFIG_REMOTE_USER="$BACKUP_REMOTE_USER"
  RCLONE_CONFIG_REMOTE_PASS="$(printf '%s' "$BACKUP_REMOTE_PASSWORD" | rclone obscure -)"
  export RCLONE_CONFIG_REMOTE_PASS
}

remote_base() { printf 'remote:%s' "${BACKUP_REMOTE_PATH:-revsign-backups}"; }
