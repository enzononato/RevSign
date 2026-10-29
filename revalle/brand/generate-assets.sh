#!/bin/sh
# Regenera os PNG/ICO/JPG da marca a partir de revalle/brand/logo.svg e icon.svg, e recolore na cor da marca a
# arte verde do Documenso que aparece no RevSign (tela final de quem assina, fundo do login, ícones dos e-mails).
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

# A arte recolorida parte sempre do original do upstream (última tag vX.Y.Z do Documenso na história, ou
# UPSTREAM_REF), e não do arquivo da árvore: rodar o script de novo não acumula a rotação de cor.
UPSTREAM_REF="${UPSTREAM_REF:-$(git -C "$ROOT" describe --tags --abbrev=0 --match 'v[0-9]*' --exclude '*-revalle*')}"
UPSTREAM_ART='packages/assets/images/signing-celebration.png packages/assets/images/background-pattern.png
  apps/remix/public/static/completed.png apps/remix/public/static/mail-open.png'
ORIG=$(mktemp -d)
trap 'rm -rf "$ORIG"' EXIT

for file in $UPSTREAM_ART; do
  mkdir -p "$ORIG/$(dirname "$file")"
  git -C "$ROOT" show "$UPSTREAM_REF:$file" > "$ORIG/$file"
done

echo "Arte do upstream: $UPSTREAM_REF"

docker run --rm -i \
  -v "$ROOT:/work" \
  -v "$ORIG:/orig:ro" \
  -w /work \
  -e HOST_UID="$(id -u)" \
  -e HOST_GID="$(id -g)" \
  "$IMAGE" sh -eu <<'SCRIPT'
apk add --no-cache -q imagemagick imagemagick-svg imagemagick-jpeg pngquant >/dev/null

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

# Arte verde do Documenso -> matiz da marca: em HSL, a matiz de todo pixel vira 209° (a do #1F4E79; 209/360 = 58.06%),
# com a saturação e a luminosidade do original (cinza continua cinza); `-modulate 100,S` tira um pouco da saturação.
# Fixar a matiz, e não girar, evita que os dois tons de verde do fundo virem ciano e violeta.
# O pngquant volta para paleta de 256 cores com alfa, como o original do upstream (RGBA cheio seria ~3x maior,
# e a imagem abre na tela final de quem assina, no celular).
brand_hue() {
  magick "/orig/$1" -colorspace HSL -channel R -evaluate set 58.06% +channel -colorspace sRGB \
    -modulate 100,"$2" -depth 8 "PNG32:$OUT/hue.png"
  pngquant --force --speed 1 --strip --output "$3" 256 "$OUT/hue.png"
}

brand_hue packages/assets/images/signing-celebration.png 80 packages/assets/images/signing-celebration.png
brand_hue packages/assets/images/background-pattern.png 70 packages/assets/images/background-pattern.png
brand_hue apps/remix/public/static/mail-open.png 100 "$OUT/mail-open.png"
# O ícone de "concluído" (círculo com visto) vira a cor da marca chapada.
magick /orig/apps/remix/public/static/completed.png -fill "$PRIMARY" -colorize 100 -strip \
  -define png:exclude-chunk=date,time "PNG32:$OUT/completed.png"

for dir in apps/remix/public/static packages/assets/static packages/email/static; do
  cp "$OUT/completed.png" "$dir/completed.png"
done

for dir in apps/remix/public/static packages/email/static; do
  cp "$OUT/mail-open.png" "$dir/mail-open.png"
done

cp "$OUT/logo.png" packages/assets/logo.png
cp "$OUT/logo_icon.png" packages/assets/logo_icon.png
cp "$OUT/logo-email.png" packages/email/static/logo.png

chown "$HOST_UID:$HOST_GID" \
  apps/remix/public/*.png apps/remix/public/*.ico apps/remix/public/*.jpg apps/remix/public/static/*.png \
  packages/assets/*.png packages/assets/*.ico packages/assets/*.jpg packages/assets/static/*.png \
  packages/email/static/*.png packages/assets/images/signing-celebration.png \
  packages/assets/images/background-pattern.png

magick -version | head -1
SCRIPT

echo 'Gerados (em apps/remix/public/ e packages/assets/): favicon.ico, favicon-16x16.png, favicon-32x32.png,'
echo '  apple-touch-icon.png, android-chrome-192x192.png, android-chrome-512x512.png, opengraph-image.jpg,'
echo '  static/logo.png, static/og-share-frame2.png; e packages/assets/logo.png, logo_icon.png,'
echo '  packages/email/static/logo.png. Recoloridos: packages/assets/images/{signing-celebration,background-pattern}.png,'
echo '  static/completed.png (apps/remix/public, packages/assets, packages/email) e static/mail-open.png'
echo '  (apps/remix/public, packages/email).'
