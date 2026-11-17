import { PDFDocument, rgb } from '@cantoo/pdf-lib';
import { prisma } from '@documenso/prisma';
import { PDF } from '@libpdf/core';
import fontkit from '@pdf-lib/fontkit';
import type { Prisma } from '@prisma/client';
import { FieldType, RevalleFinanceStatus, RevalleInvoiceFileKind, RevalleInvoiceStatus } from '@prisma/client';

import { NEXT_PRIVATE_INTERNAL_WEBAPP_URL } from '../../../constants/app';
import { fileFinanceStatus } from '../../../revalle/invoice/invoice-files';
import {
  INVOICE_ANNOTATION_FONT_SIZE,
  invoiceAnnotationLines,
  layoutInvoiceAnnotation,
  pickAnnotationField,
} from '../../../revalle/invoice/pdf-annotation';
import { logger } from '../../../utils/logger';
import { loadInvoiceFiles } from './invoice-files';

// #0070C0
const ANNOTATION_COLOR = rgb(0, 0x70 / 255, 0xc0 / 255);

export type RevalleInvoiceAnnotation = {
  lines: string[];
  /** Arquivo do envelope onde o texto entra. */
  envelopeItemId: string;
  /** Campo da primeira assinatura, em % da página; nulo = alto da primeira página. */
  field: { page: number; positionX: number; positionY: number; width: number; height: number } | null;
};

type AnnotationFieldRow = {
  type: FieldType;
  inserted: boolean;
  page: number;
  positionX: Prisma.Decimal | number;
  positionY: Prisma.Decimal | number;
  width: Prisma.Decimal | number;
  height: Prisma.Decimal | number;
  envelopeItemId: string;
};

/** A nota entra se o Financeiro aprovou a conta dela (mesma regra do certificado). */
const isAccountApproved = (financeStatus: RevalleFinanceStatus | null, approvedAt: Date | null) =>
  fileFinanceStatus(financeStatus, approvedAt) === RevalleFinanceStatus.APPROVED ||
  (financeStatus === RevalleFinanceStatus.SUPERSEDED && approvedAt !== null);

const fieldOf = (picked: AnnotationFieldRow | null): RevalleInvoiceAnnotation['field'] =>
  picked
    ? {
        page: picked.page,
        positionX: Number(picked.positionX),
        positionY: Number(picked.positionY),
        width: Number(picked.width),
        height: Number(picked.height),
      }
    : null;

// O que a anotação precisa de cada nota. `envelopeItemId` nulo = envio de antes da Fase 9, sem linha de arquivo.
type AnnotationTarget = {
  envelopeItemId: string | null;
  accountCode: string | null;
  approvedAccountName: string | null;
  costCenterCode: string | null;
};

/**
 * Os textos de conta e centro que a selagem escreve nas NFs: uma anotação por arquivo NF com linhas, acima da primeira
 * assinatura DAQUELE arquivo (sem campo: alto da primeira página). Vazio para documento comum e para NF sem conta nem
 * centro; boleto e outros arquivos não recebem nada. A conta só conta se o Financeiro aprovou; o nome é o congelado na
 * aprovação daquela nota, senão o atual da lista.
 */
export const loadRevalleInvoiceAnnotations = async (envelopeId: string): Promise<RevalleInvoiceAnnotation[]> => {
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
    return [];
  }

  const [files, items, fields] = await Promise.all([
    loadInvoiceFiles(envelopeId),
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

  const financeStatus = row.financeStatus;
  const targets: AnnotationTarget[] =
    files.length > 0
      ? files
          .filter((file) => file.kind === RevalleInvoiceFileKind.NF)
          .map((file) => ({
            envelopeItemId: file.envelopeItemId,
            accountCode: isAccountApproved(financeStatus, file.approvedAt) ? file.choiceCode : null,
            approvedAccountName: file.approvedAccountName,
            costCenterCode: file.costCenterCode,
          }))
      : // Envio de antes da Fase 9 ainda não refeito: só a linha do envio, como era (primeira assinatura de todas).
        [
          {
            envelopeItemId: null,
            accountCode: isAccountApproved(financeStatus, row.approvedAt) ? row.choiceCode : null,
            approvedAccountName: row.approvedAccountName,
            costCenterCode: row.costCenterCode,
          },
        ];

  const codesToName = [
    ...new Set(
      targets.flatMap((target) =>
        target.accountCode && target.approvedAccountName === null ? [target.accountCode] : [],
      ),
    ),
  ];
  const names = new Map<string, string>(
    codesToName.length > 0
      ? (
          await prisma.revalleAccountingAccount.findMany({
            where: { code: { in: codesToName } },
            select: { code: true, name: true },
          })
        ).map((account) => [account.code, account.name])
      : [],
  );

  const orderOf = new Map(items.map((item) => [item.id, item.order]));
  const annotations: RevalleInvoiceAnnotation[] = [];

  for (const target of targets) {
    const lines = invoiceAnnotationLines({
      accountCode: target.accountCode,
      accountName: target.approvedAccountName ?? (target.accountCode ? (names.get(target.accountCode) ?? null) : null),
      costCenterCode: target.costCenterCode,
    });

    if (lines.length === 0) {
      continue;
    }

    const picked = pickAnnotationField(
      fields
        .filter((field) => target.envelopeItemId === null || field.envelopeItemId === target.envelopeItemId)
        .map((field) => ({ ...field, itemOrder: orderOf.get(field.envelopeItemId) ?? 0 })),
    );

    if (picked) {
      annotations.push({ lines, envelopeItemId: picked.envelopeItemId, field: fieldOf(picked) });
      continue;
    }

    const itemId = target.envelopeItemId ?? items[0]?.id;

    if (itemId) {
      annotations.push({ lines, envelopeItemId: itemId, field: null });
    }
  }

  return annotations;
};

type DrawRevalleInvoiceAnnotationOptions = {
  pdfDoc: PDF;
  annotations: RevalleInvoiceAnnotation[];
  envelopeItemId: string;
};

/**
 * Escreve as linhas na página escolhida, em azul, numa página sobreposta (como o ramo V2 dos campos): as medidas são as
 * de a página ser vista, então a rotação é a mesma correção de lá. Falhar aqui não pode impedir a selagem de um
 * documento assinado: o erro vai para o log, sem dados da nota, e o PDF sai sem o texto.
 */
export const drawRevalleInvoiceAnnotation = async ({
  pdfDoc,
  annotations,
  envelopeItemId,
}: DrawRevalleInvoiceAnnotationOptions) => {
  for (const annotation of annotations) {
    if (annotation.envelopeItemId === envelopeItemId) {
      await drawOne(pdfDoc, annotation);
    }
  }
};

const drawOne = async (pdfDoc: PDF, annotation: RevalleInvoiceAnnotation) => {
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
