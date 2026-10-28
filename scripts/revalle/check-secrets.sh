#!/bin/sh
# Bloqueia segredos no repositório (RevSign).
#
# Uso:
#   check-secrets.sh --staged          # pre-commit: só o que está no stage
#   check-secrets.sh --range <base>    # CI: commits próprios da branch desde <base>
#
# Duas checagens:
#   1. Caminho: certificados, chaves e .env não podem ser versionados, nem com `git add -f`.
#      O gitleaks não detecta isso de forma confiável (o .p12 é binário).
#   2. Conteúdo: gitleaks com as regras padrão + .gitleaks.toml.

set -eu

MODE="${1:-}"
REPO_ROOT="$(git rev-parse --show-toplevel)"

# Padrões proibidos (nome do arquivo) e exceções do upstream que já vêm versionadas.
FORBIDDEN='(\.(p12|pfx|key|pem|crt)$)|((^|/)\.env(\..+)?$)'
ALLOWED='^(\.env\.example|apps/remix/example/cert\.p12)$'

if ! command -v gitleaks >/dev/null 2>&1; then
  if [ -x "$HOME/.local/bin/gitleaks" ]; then
    PATH="$HOME/.local/bin:$PATH"
  else
    echo "check-secrets: gitleaks não encontrado. Instale: https://github.com/gitleaks/gitleaks/releases" >&2
    echo "check-secrets: o commit foi bloqueado porque a checagem de segredos não pôde rodar." >&2
    exit 1
  fi
fi

case "$MODE" in
  --staged)
    FILES="$(git diff --cached --name-only --diff-filter=ACMR)"
    ;;
  --range)
    BASE="${2:?informe o commit base}"
    # --first-parent + --no-merges: só os commits feitos na branch do RevSign,
    # não os do upstream que entram por merge.
    LOG_OPTS="--first-parent --no-merges ${BASE}..HEAD"
    # shellcheck disable=SC2086
    FILES="$(git log $LOG_OPTS --name-only --diff-filter=ACMR --format= | sort -u)"
    ;;
  *)
    echo "uso: $0 --staged | --range <base>" >&2
    exit 2
    ;;
esac

BAD="$(printf '%s\n' "$FILES" | grep -E "$FORBIDDEN" | grep -Ev "$ALLOWED" || true)"

if [ -n "$BAD" ]; then
  echo "check-secrets: arquivos proibidos no repositório:" >&2
  printf '  %s\n' $BAD >&2
  echo "check-secrets: certificados, chaves e .env ficam só no painel/cofre de senhas." >&2
  exit 1
fi

cd "$REPO_ROOT"

if [ "$MODE" = "--staged" ]; then
  gitleaks git --pre-commit --staged --redact --no-banner .
else
  gitleaks git --log-opts="$LOG_OPTS" --redact --no-banner .
fi
