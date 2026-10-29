#!/bin/sh
# Regenera os PNG/ICO/JPG da marca a partir de revalle/brand/logo.svg e icon.svg.
# Roda o ImageMagick num container (alpine:3.22), sem nada instalado na máquina além do Docker.
#
# Uso, na raiz do repositório:
#   sh revalle/brand/generate-assets.sh
#
# Para trocar a marca: substitua logo.svg e icon.svg (o texto já em curvas; ver text-to-paths.mjs),
# rode este script e confira o `git diff --stat`. Os arquivos gerados estão listados no fim.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
IMAGE=alpine:3.22

docker run --rm -i \
  -v "$ROOT:/work" \
  -w /work \
  -e HOST_UID="$(id -u)" \
  -e HOST_GID="$(id -g)" \
  "$IMAGE" sh -eu <<'SCRIPT'
apk add --no-cache -q imagemagick imagemagick-svg imagemagick-jpeg >/dev/null

BRAND=revalle/brand
OUT=$(mktemp -d)
PRIMARY='#1F4E79'
GRAY='#334155'
FONT_REGULAR=packages/assets/fonts/inter-regular.ttf

# SVG -> PNG nítido: rasteriza em alta densidade e reduz.
icon() { magick -background none -density 384 "$BRAND/icon.svg" -resize "${1}x${1}" "PNG32:$2"; }
logo() { magick -background none -density 576 "$BRAND/logo.svg" -resize "x${1}" "PNG32:$2"; }

icon 16 "$OUT/favicon-16x16.png"
icon 32 "$OUT/favicon-32x32.png"
icon 48 "$OUT/icon-48.png"
icon 192 "$OUT/android-chrome-192x192.png"
icon 512 "$OUT/android-chrome-512x512.png"
icon 320 "$OUT/logo_icon.png"
magick "$OUT/favicon-16x16.png" "$OUT/favicon-32x32.png" "$OUT/icon-48.png" "$OUT/favicon.ico"

# iOS não aceita transparência no ícone (os cantos ficariam pretos) e arredonda sozinho: fundo cheio.
magick -background "$PRIMARY" -density 384 "$BRAND/icon.svg" -resize 180x180 -flatten "PNG24:$OUT/apple-touch-icon.png"

logo 320 "$OUT/logo.png"
# Logo dos e-mails e do rodapé do certificado (exibido com ~24 px de altura; 96 px para telas densas).
logo 96 "$OUT/logo-email.png"
logo 160 "$OUT/logo-og.png"

magick -size 1270x760 xc:white \
  "$OUT/logo-og.png" -gravity center -geometry +0-40 -composite \
  -font "$FONT_REGULAR" -pointsize 34 -fill "$GRAY" -gravity center \
  -annotate +0+90 'Revalle · Sistema interno de assinaturas' \
  -quality 90 "$OUT/opengraph-image.jpg"

# Moldura da imagem de compartilhamento (share.$slug.opengraph): o cartão fica em x=307, y=173, 590×337.
logo 40 "$OUT/logo-share.png"
magick -size 1200x630 xc:white \
  -fill '#F1F5F9' -stroke '#E2E8F0' -draw 'roundrectangle 287,92 913,530 24,24' \
  -fill white -stroke "$PRIMARY" -strokewidth 2 -draw 'roundrectangle 307,173 897,510 16,16' \
  -stroke none -fill "$PRIMARY" -draw 'rectangle 307,150 897,152' \
  "$OUT/logo-share.png" -gravity southeast -geometry +40+40 -composite \
  "PNG24:$OUT/og-share-frame2.png"

for dir in apps/remix/public packages/assets; do
  for file in favicon.ico favicon-16x16.png favicon-32x32.png apple-touch-icon.png \
    android-chrome-192x192.png android-chrome-512x512.png opengraph-image.jpg; do
    cp "$OUT/$file" "$dir/$file"
  done

  cp "$OUT/logo-email.png" "$dir/static/logo.png"
  cp "$OUT/og-share-frame2.png" "$dir/static/og-share-frame2.png"
done

cp "$OUT/logo.png" packages/assets/logo.png
cp "$OUT/logo_icon.png" packages/assets/logo_icon.png
cp "$OUT/logo-email.png" packages/email/static/logo.png

chown "$HOST_UID:$HOST_GID" \
  apps/remix/public/*.png apps/remix/public/*.ico apps/remix/public/*.jpg apps/remix/public/static/*.png \
  packages/assets/*.png packages/assets/*.ico packages/assets/*.jpg packages/assets/static/*.png \
  packages/email/static/logo.png

magick -version | head -1
SCRIPT

echo 'Gerados (em apps/remix/public/ e packages/assets/): favicon.ico, favicon-16x16.png, favicon-32x32.png,'
echo '  apple-touch-icon.png, android-chrome-192x192.png, android-chrome-512x512.png, opengraph-image.jpg,'
echo '  static/logo.png, static/og-share-frame2.png; e packages/assets/logo.png, logo_icon.png,'
echo '  packages/email/static/logo.png.'
