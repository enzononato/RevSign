import { PDFDocument, rgb } from '@cantoo/pdf-lib';
import { prisma } from '@documenso/prisma';
import { PDF } from '@libpdf/core';
import fontkit from '@pdf-lib/fontkit';
import { FieldType, RevalleFinanceStatus, RevalleInvoiceStatus } from '@prisma/client';

import { NEXT_PRIVATE_INTERNAL_WEBAPP_URL } from '../../../constants/app';
import {
  INVOICE_ANNOTATION_FONT_SIZE,
  invoiceAnnotationLines,
  layoutInvoiceAnnotation,
  pickAnnotationField,
} from '../../../revalle/invoice/pdf-annotation';
import { logger } from '../../../utils/logger';

// #0070C0
const ANNOTATION_COLOR = rgb(0, 0x70 / 255, 0xc0 / 255);

export type RevalleInvoiceAnnotation = {
  lines: string[];
  /** Arquivo do envelope onde o texto entra. */
  envelopeItemId: string;
  /** Campo da primeira assinatura, em % da página; nulo = alto da primeira página. */
  field: { page: number; positionX: number; positionY: number; width: number; height: number } | null;
};

/**
 * O texto da conta e do centro que a selagem escreve na NF, e onde: uma vez por selagem. Nulo para documento comum e
 * para NF sem conta nem centro. A conta só conta se o Financeiro aprovou (mesma regra do certificado); o nome é o
 * congelado na aprovação, senão o atual da lista.
 */
export const loadRevalleInvoiceAnnotation = async (envelopeId: string): Promise<RevalleInvoiceAnnotation | null> => {
  const row = await prisma.revalleInvoiceClassification.findUnique({
    where: { envelopeId },
    select: {
      isInvoice: true,
      financeStatus: true,
      choiceCode: true,
      approvedAt: true,
      approvedAccountName: true,
      costCenterCode: true,
    },
  });

  if (!row || row.isInvoice !== RevalleInvoiceStatus.YES) {
    return null;
  }

  const isApproved =
    row.financeStatus === RevalleFinanceStatus.APPROVED ||
    (row.financeStatus === RevalleFinanceStatus.SUPERSEDED && row.approvedAt !== null);
  const accountCode = isApproved ? row.choiceCode : null;

  const account =
    accountCode && row.approvedAccountName === null
      ? await prisma.revalleAccountingAccount.findUnique({ where: { code: accountCode }, select: { name: true } })
      : null;

  const lines = invoiceAnnotationLines({
    accountCode,
    accountName: row.approvedAccountName ?? account?.name ?? null,
    costCenterCode: row.costCenterCode,
  });

  if (lines.length === 0) {
    return null;
  }

  const [items, fields] = await Promise.all([
    prisma.envelopeItem.findMany({
      where: { envelopeId },
      select: { id: true, order: true },
      orderBy: { order: 'asc' },
    }),
    prisma.field.findMany({
      where: { envelopeId, type: { in: [FieldType.SIGNATURE, FieldType.FREE_SIGNATURE] }, inserted: true },
      select: {
        type: true,
        inserted: true,
        page: true,
        positionX: true,
        positionY: true,
        width: true,
        height: true,
        envelopeItemId: true,
      },
    }),
  ]);

  const orderOf = new Map(items.map((item) => [item.id, item.order]));
  const picked = pickAnnotationField(
    fields.map((field) => ({ ...field, itemOrder: orderOf.get(field.envelopeItemId) ?? 0 })),
  );

  if (picked) {
    return {
      lines,
      envelopeItemId: picked.envelopeItemId,
      field: {
        page: picked.page,
        positionX: Number(picked.positionX),
        positionY: Number(picked.positionY),
        width: Number(picked.width),
        height: Number(picked.height),
      },
    };
  }

  const first = items[0];

  return first ? { lines, envelopeItemId: first.id, field: null } : null;
};

type DrawRevalleInvoiceAnnotationOptions = {
  pdfDoc: PDF;
  annotation: RevalleInvoiceAnnotation | null;
  envelopeItemId: string;
};

/**
 * Escreve as linhas na página escolhida, em azul, numa página sobreposta (como o ramo V2 dos campos): as medidas são as
 * de a página ser vista, então a rotação é a mesma correção de lá. Falhar aqui não pode impedir a selagem de um
 * documento assinado: o erro vai para o log, sem dados da nota, e o PDF sai sem o texto.
 */
export const drawRevalleInvoiceAnnotation = async ({
  pdfDoc,
  annotation,
  envelopeItemId,
}: DrawRevalleInvoiceAnnotationOptions) => {
  if (!annotation || annotation.envelopeItemId !== envelopeItemId) {
    return;
  }

  try {
    const page = pdfDoc.getPage((annotation.field?.page ?? 1) - 1);

    if (!page) {
      throw new Error('Annotation page does not exist');
    }

    const pageWidth = page.width;
    const pageHeight = page.height;

    const fontResponse = await fetch(`${NEXT_PRIVATE_INTERNAL_WEBAPP_URL()}/fonts/noto-sans.ttf`);

    if (!fontResponse.ok) {
      throw new Error(`Font request failed with ${fontResponse.status}`);
    }

    const fontBytes = await fontResponse.arrayBuffer();

    const overlay = await PDFDocument.create();

    overlay.registerFontkit(fontkit);

    const font = await overlay.embedFont(fontBytes);
    const overlayPage = overlay.addPage([pageWidth, pageHeight]);

    const field = annotation.field;
    const layout = layoutInvoiceAnnotation({
      lines: annotation.lines,
      field: field
        ? {
            x: pageWidth * (field.positionX / 100),
            y: pageHeight * (field.positionY / 100),
            width: pageWidth * (field.width / 100),
            height: pageHeight * (field.height / 100),
          }
        : null,
      page: { width: pageWidth, height: pageHeight },
      measure: (text, size) => font.widthOfTextAtSize(text, size),
    });

    for (const line of layout.lines) {
      overlayPage.drawText(line.text, {
        x: line.x,
        y: pageHeight - line.baseline,
        size: INVOICE_ANNOTATION_FONT_SIZE,
        font,
        color: ANNOTATION_COLOR,
      });
    }

    const embeddedPage = await pdfDoc.embedPage(await PDF.load(await overlay.save()), 0);

    let translateX = 0;
    let translateY = 0;

    switch (page.rotation) {
      case 90:
        translateX = pageHeight;
        break;
      case 180:
        translateX = pageWidth;
        translateY = pageHeight;
        break;
      case 270:
        translateY = pageWidth;
        break;
    }

    page.drawPage(embeddedPage, { x: translateX, y: translateY, rotate: { angle: page.rotation } });
  } catch (error) {
    logger.error({
      msg: 'revalle invoice annotation: não foi possível escrever a conta e o centro no PDF',
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
};
