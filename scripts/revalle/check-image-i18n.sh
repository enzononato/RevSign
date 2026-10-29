#!/bin/sh
# Confere que a imagem saiu com o overlay pt-BR aplicado (REVALLE, Fase 2): o catálogo pt-BR compilado tem de conter
# frases que só existem no overlay (revalle/pt-BR.po). Se o build.sh deixar de rodar o apply-overlay, a imagem sai
# com a tradução do upstream (e "Documenso" em vários textos) sem nenhum erro de build; aqui ela não é publicada.
#
# Uso: sh scripts/revalle/check-image-i18n.sh <imagem>     (ex.: revsign:ci)
set -eu

IMAGE="${1:?informe a imagem, ex.: revsign:ci}"
CATALOG=/app/apps/remix/build/server/hono/packages/lib/translations/pt-BR/web.mjs
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cid="$(docker create "$IMAGE")"
docker cp "$cid:$CATALOG" "$TMP/web.mjs" > /dev/null 2>&1 || true
docker rm "$cid" > /dev/null

if ! test -s "$TMP/web.mjs"; then
  echo "check-image-i18n: catálogo pt-BR compilado ausente na imagem ($CATALOG)" >&2
  exit 1
fi

# Frases do overlay: o catálogo do upstream nunca diz "RevSign", e traduz as outras duas msgids de outro jeito.
for phrase in 'RevSign' 'Você tem um novo documento para ' 'Leitores'; do
  if ! grep -qF "$phrase" "$TMP/web.mjs"; then
    echo "check-image-i18n: \"$phrase\" não está no catálogo pt-BR da imagem: o overlay não foi aplicado no build" >&2
    exit 1
  fi
done

echo "check-image-i18n: overlay pt-BR presente em $IMAGE"
