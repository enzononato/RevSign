import { PDFDocument, type PDFFont, type PDFPage, rgb } from '@cantoo/pdf-lib';
import fontkit from '@pdf-lib/fontkit';

import { NEXT_PRIVATE_INTERNAL_WEBAPP_URL } from '../../../constants/app';
import { REVALLE_APP_NAME } from '../../../revalle/brand';
import { buildSendReceiptLines, type SendReceiptLine } from '../../../revalle/receipts/send-receipt';
import type { TRevalleSendReceiptData } from '../../../types/document-audit-logs';

// REVALLE: o PDF do comprovante de envio, montado na hora a partir do evento do histórico. Mesmo evento = mesmo
// conteúdo (as datas do PDF são as do evento; a fonte entra com nome fixo). Noto Sans, como o carimbo e a anotação da NF.

const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 56;
const MARGIN_TOP = 64;
const MARGIN_BOTTOM = 56;
const LABEL_WIDTH = 118;

const COLOR_TEXT = rgb(0.09, 0.1, 0.13);
const COLOR_MUTED = rgb(0.38, 0.41, 0.47);
const COLOR_BRAND = rgb(0.115, 0.248, 0.585); // hsl(223 67% 35%), o azul do RevSign
const COLOR_RULE = rgb(0.85, 0.87, 0.9);

/** Quebra em linhas que cabem na largura; palavra maior que a linha (e-mail, hash) quebra por caractere. */
const wrapText = (text: string, font: PDFFont, size: number, maxWidth: number): string[] => {
  const width = (value: string) => font.widthOfTextAtSize(value, size);
  const lines: string[] = [];
  let current = '';

  const pushLongWord = (word: string) => {
    let chunk = '';

    for (const char of word) {
      if (chunk && width(chunk + char) > maxWidth) {
        lines.push(chunk);
        chunk = char;
      } else {
        chunk += char;
      }
    }

    return chunk;
  };

  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;

    if (width(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current) {
      lines.push(current);
    }

    current = width(word) <= maxWidth ? word : pushLongWord(word);
  }

  if (current || lines.length === 0) {
    lines.push(current);
  }

  return lines;
};

const loadFontBytes = async () => {
  const response = await fetch(`${NEXT_PRIVATE_INTERNAL_WEBAPP_URL()}/fonts/noto-sans.ttf`);

  if (!response.ok) {
    throw new Error(`Font request failed with ${response.status}`);
  }

  return await response.arrayBuffer();
};

export type RenderSendReceiptPdfOptions = {
  data: TRevalleSendReceiptData;
  createdAt: Date;
  fallbackEnvelopeTitle: string;
};

export const renderSendReceiptPdf = async ({
  data,
  createdAt,
  fallbackEnvelopeTitle,
}: RenderSendReceiptPdfOptions): Promise<Uint8Array> => {
  const pdf = await PDFDocument.create({ updateMetadata: false });

  pdf.registerFontkit(fontkit);

  const font = await pdf.embedFont(await loadFontBytes(), { subset: true, customName: 'NotoSans-RevSign' });

  pdf.setTitle(`Comprovante de envio ${data.receiptId}`);
  pdf.setAuthor(REVALLE_APP_NAME);
  pdf.setCreator(REVALLE_APP_NAME);
  pdf.setProducer(REVALLE_APP_NAME);
  pdf.setLanguage('pt-BR');
  pdf.setCreationDate(createdAt);
  pdf.setModificationDate(createdAt);

  let page: PDFPage = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN_TOP;

  const ensureSpace = (height: number) => {
    if (y - height < MARGIN_BOTTOM) {
      page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN_TOP;
    }
  };

  const drawLines = (
    lines: string[],
    { x, size, color, leading }: { x: number; size: number; color: ReturnType<typeof rgb>; leading: number },
  ) => {
    for (const line of lines) {
      ensureSpace(leading);
      y -= leading;
      page.drawText(line, { x, y, size, font, color });
    }
  };

  const contentWidth = PAGE_WIDTH - MARGIN_X * 2;

  const draw = (line: SendReceiptLine) => {
    switch (line.kind) {
      case 'brand':
        drawLines([line.text], { x: MARGIN_X, size: 22, color: COLOR_BRAND, leading: 24 });
        y -= 10;
        page.drawLine({
          start: { x: MARGIN_X, y },
          end: { x: PAGE_WIDTH - MARGIN_X, y },
          thickness: 1,
          color: COLOR_RULE,
        });
        y -= 8;
        return;
      case 'title':
        drawLines(wrapText(line.text, font, 18, contentWidth), {
          x: MARGIN_X,
          size: 18,
          color: COLOR_TEXT,
          leading: 26,
        });
        y -= 4;
        return;
      case 'intro':
        drawLines(wrapText(line.text, font, 10, contentWidth), {
          x: MARGIN_X,
          size: 10,
          color: COLOR_MUTED,
          leading: 14,
        });
        return;
      case 'section':
        drawLines([line.text.toUpperCase()], { x: MARGIN_X, size: 9, color: COLOR_BRAND, leading: 16 });
        y -= 2;
        return;
      case 'field': {
        const size = line.small ? 8.5 : 10.5;
        const leading = line.small ? 12 : 15;
        const valueLines = wrapText(line.value, font, size, contentWidth - LABEL_WIDTH);

        ensureSpace(leading);
        page.drawText(line.label, { x: MARGIN_X, y: y - leading, size: 9.5, font, color: COLOR_MUTED });
        drawLines(valueLines, { x: MARGIN_X + LABEL_WIDTH, size, color: COLOR_TEXT, leading });
        y -= 2;
        return;
      }
      case 'spacer':
        y -= 10;
        return;
      case 'footer':
        drawLines(wrapText(line.text, font, 8, contentWidth), {
          x: MARGIN_X,
          size: 8,
          color: COLOR_MUTED,
          leading: 11,
        });
        return;
    }
  };

  for (const line of buildSendReceiptLines({ data, createdAt, fallbackEnvelopeTitle })) {
    draw(line);
  }

  return await pdf.save({ useObjectStreams: false });
};
