import { PDFDocument, rgb } from '@cantoo/pdf-lib';
import { prisma } from '@documenso/prisma';
import { PDF } from '@libpdf/core';
import fontkit from '@pdf-lib/fontkit';
import type { Prisma } from '@prisma/client';
import { FieldType, RevalleFinanceStatus, RevalleInvoiceFileKind, RevalleInvoiceStatus } from '@prisma/client';

import { NEXT_PRIVATE_INTERNAL_WEBAPP_URL } from '../../../constants/app';
import { type AnnotationBoxRect, placeAnnotationText } from '../../../revalle/invoice/annotation-box';
import { fileFinanceStatus } from '../../../revalle/invoice/invoice-files';
import {
  INVOICE_ANNOTATION_FONT_SIZE,
  invoiceAnnotationLines,
  layoutInvoiceAnnotation,
  pickAnnotationField,
} from '../../../revalle/invoice/pdf-annotation';
import { logger } from '../../../utils/logger';
import { findInvoiceAnnotationBoxes } from './annotation-box';
import { loadInvoiceFiles } from './invoice-files';

// #0070C0
const ANNOTATION_COLOR = rgb(0, 0x70 / 255, 0xc0 / 255);
// Dentro do bloco, a fonte encolhe até aqui antes de quebrar linha.
const ANNOTATION_BOX_MIN_FONT_SIZE = 6;

export type RevalleInvoiceAnnotation = {
  /** Só para o log de uma falha (nunca dados da nota). */
  envelopeId: string;
  lines: string[];
  /** Arquivo do envelope onde o texto entra. */
  envelopeItemId: string;
  /** Envio de antes do bloco: campo da primeira assinatura, em % da página; nulo = alto da primeira página. */
  field: { page: number; positionX: number; positionY: number; width: number; height: number } | null;
  /** O bloco "Conta e centro de custo" do arquivo: o texto vai dentro dele (e `field` fica nulo). */
  box?: AnnotationBoxRect | null;
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
 * Os textos de conta e centro que a selagem escreve nas NFs: uma anotação por arquivo NF com linhas, dentro do bloco
 * "Conta e centro de custo" que o remetente pôs naquele arquivo; NF sem bloco não recebe nada. Envio de antes do bloco
 * (`autoAnnotation`): como era, acima da primeira assinatura DAQUELE arquivo (sem campo: alto da primeira página), e o
 * bloco não vale. Vazio para documento comum e para NF sem conta nem centro; boleto e outros arquivos não recebem nada,
 * nem com bloco. A conta só conta se o Financeiro aprovou; o nome é o congelado na aprovação daquela nota, senão o atual
 * da lista.
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
      autoAnnotation: true,
    },
  });

  if (!row || row.isInvoice !== RevalleInvoiceStatus.YES) {
    return [];
  }

  if (!row.autoAnnotation) {
    return await loadBoxAnnotations(envelopeId, row.financeStatus);
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

  const linesOf = await annotationLinesLoader(targets);
  const orderOf = new Map(items.map((item) => [item.id, item.order]));
  const annotations: RevalleInvoiceAnnotation[] = [];

  for (const target of targets) {
    const lines = linesOf(target);

    if (lines.length === 0) {
      continue;
    }

    const picked = pickAnnotationField(
      fields
        .filter((field) => target.envelopeItemId === null || field.envelopeItemId === target.envelopeItemId)
        .map((field) => ({ ...field, itemOrder: orderOf.get(field.envelopeItemId) ?? 0 })),
    );

    if (picked) {
      annotations.push({ envelopeId, lines, envelopeItemId: picked.envelopeItemId, field: fieldOf(picked) });
      continue;
    }

    const itemId = target.envelopeItemId ?? items[0]?.id;

    if (itemId) {
      annotations.push({ envelopeId, lines, envelopeItemId: itemId, field: null });
    }
  }

  return annotations;
};

/** As linhas de cada nota, com o nome atual da lista para a conta aprovada sem nome congelado (uma consulta só). */
const annotationLinesLoader = async (targets: AnnotationTarget[]) => {
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

  return (target: AnnotationTarget) =>
    invoiceAnnotationLines({
      accountCode: target.accountCode,
      accountName: target.approvedAccountName ?? (target.accountCode ? (names.get(target.accountCode) ?? null) : null),
      costCenterCode: target.costCenterCode,
    });
};

/** A regra nova: só arquivo NF com bloco, e o texto vai dentro do bloco. */
const loadBoxAnnotations = async (
  envelopeId: string,
  financeStatus: RevalleFinanceStatus | null,
): Promise<RevalleInvoiceAnnotation[]> => {
  const boxes = await findInvoiceAnnotationBoxes(envelopeId);

  if (boxes.length === 0) {
    return [];
  }

  const boxOf = new Map(boxes.map(({ envelopeItemId, ...rect }) => [envelopeItemId, rect]));
  const files = (await loadInvoiceFiles(envelopeId)).filter(
    (file) => file.kind === RevalleInvoiceFileKind.NF && boxOf.has(file.envelopeItemId),
  );
  const targets: Array<AnnotationTarget & { envelopeItemId: string }> = files.map((file) => ({
    envelopeItemId: file.envelopeItemId,
    accountCode: isAccountApproved(financeStatus, file.approvedAt) ? file.choiceCode : null,
    approvedAccountName: file.approvedAccountName,
    costCenterCode: file.costCenterCode,
  }));
  const linesOf = await annotationLinesLoader(targets);

  return targets.flatMap((target) => {
    const lines = linesOf(target);
    const box = boxOf.get(target.envelopeItemId);

    return lines.length > 0 && box
      ? [{ envelopeId, lines, envelopeItemId: target.envelopeItemId, field: null, box }]
      : [];
  });
};

type DrawRevalleInvoiceAnnotationOptions = {
  pdfDoc: PDF;
  annotations: RevalleInvoiceAnnotation[];
  envelopeItemId: string;
  /** Páginas do próprio arquivo: o certificado e o log já foram anexados ao fim de `pdfDoc` e não recebem o texto. */
  documentPageCount: number;
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
  documentPageCount,
}: DrawRevalleInvoiceAnnotationOptions) => {
  for (const annotation of annotations) {
    if (annotation.envelopeItemId === envelopeItemId) {
      await drawOne(pdfDoc, annotation, documentPageCount);
    }
  }
};

const drawOne = async (pdfDoc: PDF, annotation: RevalleInvoiceAnnotation, documentPageCount: number) => {
  try {
    const pageNumber = annotation.box?.page ?? annotation.field?.page ?? 1;
    const page = pageNumber >= 1 && pageNumber <= documentPageCount ? pdfDoc.getPage(pageNumber - 1) : null;

    // O bloco numa página que não existe mais (o arquivo foi trocado por um mais curto): sai sem o texto.
    if (!page) {
      logger.error({
        msg: 'revalle invoice annotation: a página da conta e do centro não existe no PDF',
        envelopeId: annotation.envelopeId,
        error: 'AnnotationPageMissing',
      });

      return;
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

    const toPt = (rect: { positionX: number; positionY: number; width: number; height: number }) => ({
      x: pageWidth * (rect.positionX / 100),
      y: pageHeight * (rect.positionY / 100),
      width: pageWidth * (rect.width / 100),
      height: pageHeight * (rect.height / 100),
    });
    const measure = (text: string, size: number) => font.widthOfTextAtSize(text, size);
    const field = annotation.field;
    const layout = annotation.box
      ? placeAnnotationText({
          lines: annotation.lines,
          box: toPt(annotation.box),
          pageHeight,
          measure,
          maxSize: INVOICE_ANNOTATION_FONT_SIZE,
          minSize: ANNOTATION_BOX_MIN_FONT_SIZE,
        })
      : layoutInvoiceAnnotation({
          lines: annotation.lines,
          field: field ? toPt(field) : null,
          page: { width: pageWidth, height: pageHeight },
          measure,
        });

    for (const line of layout.lines) {
      overlayPage.drawText(line.text, {
        x: line.x,
        y: pageHeight - line.baseline,
        size: layout.size,
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
      envelopeId: annotation.envelopeId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
};
