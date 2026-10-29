// Gera logo.svg e icon.svg com o texto já convertido em curvas (Inter SemiBold do repositório), para o desenho
// não depender da fonte instalada em quem abre o SVG (navegador, ImageMagick, cliente de e-mail).
// Uso (na raiz do repositório, com `npm ci` feito): node revalle/brand/text-to-paths.mjs
// Marca provisória: quando a Revalle mandar a definitiva, troque os SVGs (à mão ou aqui) e rode generate-assets.sh.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fontkit from '@pdf-lib/fontkit';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const font = fontkit.create(readFileSync(path.join(HERE, '../../packages/assets/fonts/inter-semibold.ttf')));

const PRIMARY = '#1F4E79';
const GRAY = '#334155';

const round = (svgPath) => svgPath.replace(/-?\d+\.\d+/g, (n) => String(Math.round(Number(n) * 100) / 100));

// Cada pedaço do texto vira um <path>, com o kerning do texto inteiro. `size` em unidades do SVG; y = linha de base.
const textPaths = (pieces, { size, x0 = 0, baseline }) => {
  const text = pieces.map((piece) => piece.text).join('');
  const run = font.layout(text);
  const scale = size / font.unitsPerEm;
  const out = pieces.map(() => []);
  let x = x0;
  let index = 0;
  let pieceIndex = 0;
  let pieceEnd = pieces[0].text.length;

  run.glyphs.forEach((glyph, i) => {
    while (index >= pieceEnd) {
      pieceIndex += 1;
      pieceEnd += pieces[pieceIndex].text.length;
    }

    const position = run.positions[i];
    const glyphPath = glyph.path
      .scale(scale, -scale)
      .translate(x + position.xOffset * scale, baseline - position.yOffset * scale);

    out[pieceIndex].push(glyphPath.toSVG());
    x += position.xAdvance * scale;
    index += glyph.codePoints.length || 1;
  });

  return { paths: out.map((parts) => round(parts.join(''))), width: x - x0 };
};

const capHeight = (size) => (font.capHeight / font.unitsPerEm) * size;

const logo = () => {
  const size = 100;
  const pad = 4;
  const cap = capHeight(size);
  const descent = (-font.descent / font.unitsPerEm) * size;
  const baseline = pad + cap;
  const { paths, width } = textPaths(
    [
      { text: 'Rev', color: PRIMARY },
      { text: 'Sign', color: GRAY },
    ],
    { size, x0: pad, baseline },
  );
  // "g" desce abaixo da linha de base: a altura cobre a descendente.
  const height = Math.ceil(baseline + descent * 0.85 + pad);
  const viewWidth = Math.ceil(width + pad * 2);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewWidth} ${height}" width="${viewWidth}" height="${height}">
  <title>RevSign</title>
  <path fill="${PRIMARY}" d="${paths[0]}"/>
  <path fill="${GRAY}" d="${paths[1]}"/>
</svg>
`;
};

const icon = () => {
  const box = 512;
  const size = 360;
  const { bbox } = font.layout('R').glyphs[0];
  const scale = size / font.unitsPerEm;
  // Centraliza pelo desenho do "R" (não pelo avanço), na horizontal e na vertical.
  const x0 = (box - (bbox.maxX - bbox.minX) * scale) / 2 - bbox.minX * scale;
  const baseline = (box + capHeight(size)) / 2;
  const { paths } = textPaths([{ text: 'R' }], { size, x0, baseline });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}" width="${box}" height="${box}">
  <title>RevSign</title>
  <rect width="${box}" height="${box}" rx="112" fill="${PRIMARY}"/>
  <path fill="#FFFFFF" d="${paths[0]}"/>
</svg>
`;
};

writeFileSync(path.join(HERE, 'logo.svg'), logo());
writeFileSync(path.join(HERE, 'icon.svg'), icon());
