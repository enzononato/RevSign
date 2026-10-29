#!/bin/sh
# Testes de integração da imagem de backup. Autocontido: cria o próprio banco de teste.
# Uso: sh revalle/backup/test/run-tests.sh   (a imagem revsign-backup:test precisa existir)
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE="${REVSIGN_BACKUP_TEST_IMAGE:-revsign-backup:test}"
TMP="$(mktemp -d)"
export TEST_PASS="$(od -An -tx1 -N12 /dev/urandom | tr -d ' \n')"
export TEST_ID_FILE="$TMP/id.txt"
export REVSIGN_BACKUP_TEST_IMAGE="$IMAGE"
DC="docker compose -f $HERE/compose.test.yml"
FAILED=0

cleanup() {
  $DC down -v --remove-orphans >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "FAIL setup: imagem $IMAGE não existe (docker build -t $IMAGE revalle/backup)"
  exit 1
fi

# Chave age de teste, gerada em tempo de execução.
docker run --rm --entrypoint age-keygen "$IMAGE" 2>/dev/null >"$TMP/id.txt"
chmod 644 "$TMP/id.txt"
RECIPIENT="$(docker run --rm -v "$TMP/id.txt:/id.txt:ro" --entrypoint age-keygen "$IMAGE" -y /id.txt)"
export RECIPIENT

# Executa um comando dentro da imagem (com env do compose + vars do chamador).
# stderr do compose/rclone é descartado (ruído); use VERBOSE=1 para depurar.
run() { if [ "${VERBOSE:-0}" = 1 ]; then $DC run --rm -T --no-deps "$@" 2>&1; else $DC run --rm -T --no-deps "$@" 2>/dev/null; fi; }
# Roda um shell na imagem com o remote configurado (common.sh).
sh_in() { run --entrypoint sh backup -c ". /usr/local/lib/revsign/common.sh; setup_remote; $1"; }

$DC up -d --wait db sftp ftps >/dev/null 2>&1 || { echo "FAIL setup: infra não subiu"; exit 1; }
# espera o servidor FTPS (gera o certificado ao subir) e o SFTP responderem
for t in sftp ftps; do
  n=0
  until BACKUP_REMOTE_TYPE=$t BACKUP_REMOTE_HOST=$t sh_in 'rclone lsf remote: >/dev/null' >/dev/null 2>&1; do
    n=$((n + 1)); [ "$n" -lt 40 ] || { echo "FAIL setup: $t não respondeu"; exit 1; }
    sleep 3
  done
done

reset() {
  # limpa local e remoto (sftp e ftps) antes de cada caso
  BACKUP_REMOTE_TYPE=none run --entrypoint sh backup -c 'rm -rf /backups/* /backups/.[!.]*' >/dev/null
  for t in sftp ftps; do
    h="$t"; BACKUP_REMOTE_TYPE=$t BACKUP_REMOTE_HOST=$h BACKUP_REMOTE_PATH="$(path_for $t)" \
      sh_in 'rclone purge remote:"$BACKUP_REMOTE_PATH"' >/dev/null 2>&1
  done
}
path_for() { [ "$1" = sftp ] && echo upload/revsign-backups || echo revsign-backups; }

report() { # nome status
  if [ "$2" = 0 ]; then echo "PASS $1"; else echo "FAIL $1"; FAILED=1; fi
}

# Verifica que o arquivo mais novo do remoto decifra e é um dump válido.
remote_roundtrip() { # tipo
  t="$1"
  BACKUP_REMOTE_TYPE=$t BACKUP_REMOTE_HOST=$t BACKUP_REMOTE_PATH="$(path_for $t)" \
    sh_in 'f=$(rclone lsf --files-only --include "revsign-*.dump.age" remote:"$BACKUP_REMOTE_PATH" | sort | tail -n1)
           [ -n "$f" ] && rclone cat remote:"$BACKUP_REMOTE_PATH/$f" | age -d -i /id.txt | pg_restore --list | grep -q notas'
}

remote_backup_case() { # tipo
  t="$1"; reset
  BACKUP_AGE_RECIPIENT="$RECIPIENT" BACKUP_REMOTE_TYPE=$t BACKUP_REMOTE_HOST=$t \
    BACKUP_REMOTE_PATH="$(path_for $t)" run --entrypoint backup.sh backup >/dev/null
  rc1=$?
  remote_roundtrip $t; rc2=$?
  # o cópia local também existe
  BACKUP_REMOTE_TYPE=none run --entrypoint sh backup -c 'ls /backups/revsign-*.dump.age >/dev/null' >/dev/null; rc3=$?
  [ $rc1 = 0 ] && [ $rc2 = 0 ] && [ $rc3 = 0 ]
}

remote_backup_case sftp; report sftp-ok $?
remote_backup_case ftps; report ftps-ok $?

# no-recipient: sem chave age, nada é gravado nem enviado.
reset
BACKUP_AGE_RECIPIENT="" BACKUP_REMOTE_TYPE=sftp BACKUP_REMOTE_HOST=sftp BACKUP_REMOTE_PATH=upload/revsign-backups \
  run --entrypoint backup.sh backup >/dev/null
rc=$?
BACKUP_REMOTE_TYPE=none run --entrypoint sh backup -c 'ls /backups/revsign-* 2>/dev/null' >"$TMP/l.out"
BACKUP_REMOTE_TYPE=sftp BACKUP_REMOTE_HOST=sftp BACKUP_REMOTE_PATH=upload/revsign-backups \
  sh_in 'rclone lsf remote:"$BACKUP_REMOTE_PATH" 2>/dev/null' >"$TMP/r.out"
[ $rc != 0 ] && [ ! -s "$TMP/l.out" ] && ! grep -q dump "$TMP/r.out"; report no-recipient $?

# remote-down: host inexistente.
reset
BACKUP_AGE_RECIPIENT="$RECIPIENT" BACKUP_REMOTE_TYPE=sftp BACKUP_REMOTE_HOST=host-inexistente.invalid \
  run --entrypoint backup.sh backup >/dev/null
rc=$?
BACKUP_REMOTE_TYPE=none run --entrypoint sh backup -c 'ls /backups/revsign-*.dump.age >/dev/null && grep -q "\"status\":\"error\"" /backups/last-run.json' >/dev/null
rc2=$?
[ $rc != 0 ] && [ $rc2 = 0 ]; report remote-down $?

# retention: 40 dias some dos dois lados; 10 dias fica.
reset
BACKUP_REMOTE_TYPE=none run --entrypoint sh backup -c '
  old=$(date -d @$(( $(date +%s) - 40*86400 )) "+%Y-%m-%d %H:%M:%S")
  recent=$(date -d @$(( $(date +%s) - 10*86400 )) "+%Y-%m-%d %H:%M:%S")
  : > /backups/revsign-20000101-000000.dump.age; touch -d "$old" /backups/revsign-20000101-000000.dump.age
  : > /backups/revsign-20000201-000000.dump.age; touch -d "$recent" /backups/revsign-20000201-000000.dump.age' >/dev/null
BACKUP_REMOTE_TYPE=sftp BACKUP_REMOTE_HOST=sftp BACKUP_REMOTE_PATH=upload/revsign-backups sh_in '
  mkdir -p /tmp/s; cd /tmp/s
  old=$(date -d @$(( $(date +%s) - 40*86400 )) "+%Y-%m-%d %H:%M:%S")
  recent=$(date -d @$(( $(date +%s) - 10*86400 )) "+%Y-%m-%d %H:%M:%S")
  : > revsign-20000101-000000.dump.age; touch -d "$old" revsign-20000101-000000.dump.age
  : > revsign-20000201-000000.dump.age; touch -d "$recent" revsign-20000201-000000.dump.age
  rclone copy /tmp/s remote:"$BACKUP_REMOTE_PATH"' >/dev/null
BACKUP_AGE_RECIPIENT="$RECIPIENT" BACKUP_REMOTE_TYPE=sftp BACKUP_REMOTE_HOST=sftp BACKUP_REMOTE_PATH=upload/revsign-backups \
  BACKUP_RETENTION_DAYS=30 run --entrypoint backup.sh backup >/dev/null
rc=$?
BACKUP_REMOTE_TYPE=none run --entrypoint sh backup -c 'ls /backups' >"$TMP/l.out"
BACKUP_REMOTE_TYPE=sftp BACKUP_REMOTE_HOST=sftp BACKUP_REMOTE_PATH=upload/revsign-backups \
  sh_in 'rclone lsf remote:"$BACKUP_REMOTE_PATH"' >"$TMP/r.out"
[ $rc = 0 ] && ! grep -q 20000101 "$TMP/l.out" && grep -q 20000201 "$TMP/l.out" \
  && ! grep -q 20000101 "$TMP/r.out" && grep -q 20000201 "$TMP/r.out"; report retention $?

# keeps-newest: um único arquivo de 40 dias nunca é apagado (local e remoto).
reset
BACKUP_REMOTE_TYPE=sftp BACKUP_REMOTE_HOST=sftp BACKUP_REMOTE_PATH=upload/revsign-backups sh_in '
  old=$(date -d @$(( $(date +%s) - 40*86400 )) "+%Y-%m-%d %H:%M:%S")
  : > /backups/revsign-20000101-000000.dump.age; touch -d "$old" /backups/revsign-20000101-000000.dump.age
  mkdir -p /tmp/s; cp -p /backups/revsign-20000101-000000.dump.age /tmp/s/
  rclone copy /tmp/s remote:"$BACKUP_REMOTE_PATH"' >/dev/null
BACKUP_REMOTE_TYPE=sftp BACKUP_REMOTE_HOST=sftp BACKUP_REMOTE_PATH=upload/revsign-backups \
  BACKUP_RETENTION_DAYS=30 run --entrypoint prune.sh backup >/dev/null
rc=$?
BACKUP_REMOTE_TYPE=none run --entrypoint sh backup -c 'ls /backups' >"$TMP/l.out"
BACKUP_REMOTE_TYPE=sftp BACKUP_REMOTE_HOST=sftp BACKUP_REMOTE_PATH=upload/revsign-backups \
  sh_in 'rclone lsf remote:"$BACKUP_REMOTE_PATH"' >"$TMP/r.out"
[ $rc = 0 ] && grep -q 20000101 "$TMP/l.out" && grep -q 20000101 "$TMP/r.out"; report keeps-newest $?

[ "$FAILED" = 0 ] && echo "TODOS OS TESTES PASSARAM" || echo "HÁ TESTES COM FALHA"
exit "$FAILED"
