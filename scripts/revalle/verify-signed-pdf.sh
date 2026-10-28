#!/bin/sh
# Verifica o PDF final selado pelo RevSign.
#
# Uso: verify-signed-pdf.sh <final.pdf> [original.pdf]
#
# Confere:
#   1. A última assinatura digital está íntegra ("Signature is Valid.").
#   2. Ela cobre o documento inteiro ("Total document signed").
#   3. Com o original: o PDF final tem mais páginas (certificado e log anexados).
#
# A confiança na cadeia do certificado é só informativa: o autoassinado de
# homologação nunca é "trusted"; o e-CNPJ depende da lista de confiança do leitor.
#
# Usa pdfsig/pdfinfo (poppler) locais ou, se não houver, um container Alpine.

set -eu

FINAL="${1:?uso: $0 <final.pdf> [original.pdf]}"
ORIGINAL="${2:-}"

run_poppler() {
  tool="$1"
  file="$2"

  if command -v "$tool" >/dev/null 2>&1; then
    "$tool" "$file"
  else
    dir="$(cd "$(dirname "$file")" && pwd)"
    docker run --rm -v "$dir:/pdf:ro" alpine:3.22 \
      sh -c "apk add --no-cache -q poppler-utils >/dev/null && $tool \"/pdf/$(basename "$file")\""
  fi
}

pages() {
  run_poppler pdfinfo "$1" | awk '/^Pages:/ { print $2 }'
}

SIG="$(run_poppler pdfsig "$FINAL" || true)"
printf '%s\n' "$SIG"

# Bloco da última assinatura (a selagem do RevSign é a última aplicada).
LAST="$(printf '%s\n' "$SIG" | awk '/^Signature #/ { block = "" } { block = block $0 "\n" } END { printf "%s", block }')"

FAIL=0

if printf '%s' "$LAST" | grep -q 'Signature is Valid.'; then
  echo "OK    assinatura íntegra"
else
  echo "FALHA assinatura ausente ou inválida"
  FAIL=1
fi

if printf '%s' "$LAST" | grep -q 'Total document signed'; then
  echo "OK    assinatura cobre o documento inteiro"
else
  echo "FALHA assinatura não cobre o documento inteiro"
  FAIL=1
fi

if [ -n "$ORIGINAL" ]; then
  P_ORIG="$(pages "$ORIGINAL")"
  P_FINAL="$(pages "$FINAL")"

  if [ "$P_FINAL" -gt "$P_ORIG" ]; then
    echo "OK    páginas: original $P_ORIG, final $P_FINAL (certificado/log anexados)"
  else
    echo "FALHA páginas: original $P_ORIG, final $P_FINAL (certificado/log não anexados?)"
    FAIL=1
  fi
fi

exit "$FAIL"
