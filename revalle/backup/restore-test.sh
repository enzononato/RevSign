#!/bin/sh
# Prova de restauração: restaura um backup cifrado num Postgres descartável e
# confere que um PDF selado volta íntegro. Roda no WSL/host com Docker.
#
# Uso: restore-test.sh <arquivo.dump.age|latest> <age-identity-file>
#
#   latest  baixa o mais novo do destino remoto, com as mesmas variáveis
#           BACKUP_REMOTE_* do serviço de backup (exportadas no shell).
#
# Variáveis opcionais:
#   REVSIGN_BACKUP_IMAGE  imagem usada para age/rclone (padrão: a da homologação)
#
# O dump em texto puro nunca vai a disco: age -> pg_restore por pipe.
# Sai 0 só se: há envelope COMPLETED e verify-signed-pdf.sh aprova o PDF selado.

set -eu

SRC="${1:?uso: $0 <arquivo.dump.age|latest> <age-identity-file>}"
IDENTITY="${2:?uso: $0 <arquivo.dump.age|latest> <age-identity-file>}"
IMG="${REVSIGN_BACKUP_IMAGE:-ghcr.io/enzononato/revsign-backup:v2.21.1-revalle.3}"
HERE="$(cd "$(dirname "$0")" && pwd)"
VERIFY="$HERE/../../scripts/revalle/verify-signed-pdf.sh"

[ -f "$IDENTITY" ] || { echo "FALHA identidade age não encontrada"; exit 1; }
IDENTITY="$(cd "$(dirname "$IDENTITY")" && pwd)/$(basename "$IDENTITY")"

WORK="$(mktemp -d)"
chmod 777 "$WORK"
PG="revsign-restore-test-$$"
cleanup() {
  docker rm -f "$PG" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

if [ "$SRC" = latest ]; then
  echo "1. baixando o backup mais novo do destino remoto"
  docker run --rm -v "$WORK:/out" \
    -e BACKUP_REMOTE_TYPE -e BACKUP_REMOTE_HOST -e BACKUP_REMOTE_PORT -e BACKUP_REMOTE_USER \
    -e BACKUP_REMOTE_PASSWORD -e BACKUP_REMOTE_PATH -e BACKUP_REMOTE_INSECURE_TLS \
    --entrypoint sh "$IMG" -c '
      . /usr/local/lib/revsign/common.sh
      [ "${BACKUP_REMOTE_TYPE:-none}" != none ] || { echo "defina BACKUP_REMOTE_*" >&2; exit 1; }
      setup_remote
      f="$(rclone lsf --files-only --include "$PATTERN" "$(remote_base)" | sort | tail -n 1)"
      [ -n "$f" ] || { echo "nenhum backup no destino remoto" >&2; exit 1; }
      echo "arquivo: $f"
      rclone copyto "$(remote_base)/$f" /out/in.dump.age' 2>/dev/null
  ENC="$WORK/in.dump.age"
else
  [ -f "$SRC" ] || { echo "FALHA arquivo não encontrado: $SRC"; exit 1; }
  ENC="$(cd "$(dirname "$SRC")" && pwd)/$(basename "$SRC")"
  echo "1. usando o arquivo local $(basename "$ENC")"
fi

echo "2. subindo Postgres descartável"
docker run -d --name "$PG" -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=restore postgres:17 >/dev/null
n=0
until docker exec "$PG" pg_isready -U postgres -d restore >/dev/null 2>&1; do
  n=$((n + 1)); [ "$n" -lt 60 ] || { echo "FALHA Postgres não subiu"; exit 1; }
  sleep 1
done
# o init do postgres reinicia o servidor uma vez; espera estabilizar
sleep 3
until docker exec "$PG" pg_isready -U postgres -d restore >/dev/null 2>&1; do sleep 1; done

echo "3. decifrando e restaurando (sem gravar o dump em texto puro)"
docker run --rm -i -v "$IDENTITY:/id:ro" --entrypoint age "$IMG" -d -i /id <"$ENC" \
  | docker exec -i "$PG" pg_restore -U postgres -d restore --no-owner --no-privileges --exit-on-error \
  || { echo "FALHA decifrar/restaurar"; exit 1; }

sql() { docker exec "$PG" psql -U postgres -d restore -At -c "$1"; }

DONE="$(sql "select count(*) from \"Envelope\" where status='COMPLETED'")"
echo "4. envelopes concluídos: $DONE"
[ "$DONE" -gt 0 ] || { echo "FALHA nenhum envelope COMPLETED no backup"; exit 1; }

SEL="from \"DocumentData\" dd
  join \"EnvelopeItem\" i on i.\"documentDataId\" = dd.id
  join \"Envelope\" e on e.id = i.\"envelopeId\"
  where e.status = 'COMPLETED' and dd.type = 'BYTES_64'
  order by e.\"createdAt\" desc limit 1"
sql "select dd.data $SEL" | base64 -d >"$WORK/final.pdf"
sql "select dd.\"initialData\" $SEL" | base64 -d >"$WORK/original.pdf"
[ -s "$WORK/final.pdf" ] || { echo "FALHA PDF selado vazio"; exit 1; }

echo "5. verificando o PDF selado restaurado"
sh "$VERIFY" "$WORK/final.pdf" "$WORK/original.pdf" || { echo "FALHA verificação do PDF selado"; exit 1; }

echo "RESUMO: restauração OK, $DONE envelope(s) concluído(s), PDF selado íntegro"
