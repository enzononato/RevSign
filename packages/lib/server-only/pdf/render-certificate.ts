// sort-imports-ignore
import '../konva/skia-backend';

import fs from 'node:fs';
import path from 'node:path';
import type { Canvas } from '@documenso/skia-canvas';
import { Image as SkiaImage } from '@documenso/skia-canvas';
import type { I18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { Field, RecipientRole, Signature } from '@prisma/client';
import { SigningStatus } from '@prisma/client';
import Konva from 'konva';
import { UAParser } from 'ua-parser-js';
import { renderSVG } from 'uqr';

import { NEXT_PUBLIC_WEBAPP_URL } from '../../constants/app';
import { getSignatureFontFamily } from '../../constants/pdf';
import { RECIPIENT_ROLE_SIGNING_REASONS, RECIPIENT_ROLES_DESCRIPTION } from '../../constants/recipient-roles';
import { formatRevalleDateTime, REVALLE_TIME_ZONE_NOTE } from '../../revalle/date-format'; // REVALLE: datas dd/MM/yyyy HH:mm em America/Bahia
import { REVALLE_STAMP_ONLY_LABEL } from '../../revalle/stamp'; // REVALLE:
import type { TDocumentAuditLogBaseSchema } from '../../types/document-audit-logs';
import { svgToPng } from '../../utils/images/svg-to-png';
import type { RevalleCertificateHeaderLine, RevalleCertificateRecipient } from '../revalle/certificate-data'; // REVALLE:
import { ensureFontLibrary } from './helpers';

type ColumnWidths = [number, number, number];

type BaseAuditLog = Pick<TDocumentAuditLogBaseSchema, 'createdAt' | 'ipAddress' | 'userAgent'>;

export type CertificateRecipient = {
  id: number;
  name: string;
  email: string;
  role: RecipientRole;
  rejectionReason: string | null;
  signingStatus: SigningStatus;
  signatureField?: Pick<Field, 'id' | 'secondaryId' | 'recipientId'> & {
    signature?: Pick<Signature, 'signatureImageAsBase64' | 'typedSignature'> | null;
  };
  authLevel: string;
  logs: {
    emailed: BaseAuditLog | null;
    sent: BaseAuditLog | null;
    opened: BaseAuditLog | null;
    completed: BaseAuditLog | null;
    rejected: BaseAuditLog | null;
  };
  revalle?: RevalleCertificateRecipient | null; // REVALLE: prova congelada (nula em documento anterior à Fase 4)
};

type GenerateCertificateOptions = {
  recipients: CertificateRecipient[];
  envelopeId: string;
  qrToken: string | null;
  hidePoweredBy: boolean;
  i18n: I18n;
  envelopeOwner: {
    name: string;
    email: string;
  };
  pageWidth: number;
  pageHeight: number;
  revalleHeaderLines?: RevalleCertificateHeaderLine[]; // REVALLE: "SHA-256 do original: <hex>" e a conta da NF aprovada
};

// Helper function to get device info from user agent
const getDevice = (userAgent?: string | null): string => {
  if (!userAgent) {
    return 'Unknown';
  }

  const parser = new UAParser(userAgent);

  parser.setUA(userAgent);

  const result = parser.getResult();

  return `${result.os.name} - ${result.browser.name} ${result.browser.version}`;
};

const textMutedForegroundLight = '#929DAE';
const textForeground = '#000';
const textMutedForeground = '#64748B';
const textRejectedRed = '#dc2626';
const textBase = 10;
const textSm = 9;
const textXs = 8;
const fontMedium = '500';

const columnWidthPercentages = [30, 30, 40];
const rowPadding = 12;
const tableHeaderHeight = 38;
const pageTopMargin = 72;
const pageBottomMargin = 24;
const contentMaxWidth = 768;

const titleFontSize = 18;

type RenderLabelAndTextOptions = {
  label: string;
  text: string;
  width: number;
  y?: number;
  labelFill?: string;
  valueFill?: string;
  wrap?: 'word' | 'char'; // REVALLE: linhas da prova quebram por palavra
};

const renderLabelAndText = (options: RenderLabelAndTextOptions) => {
  const { width, y } = options;

  const group = new Konva.Group({
    y,
  });

  const labelFill = options.labelFill ?? textMutedForeground;
  const valueFill = options.valueFill ?? textMutedForeground;

  const label = new Konva.Text({
    x: 0,
    y: 0,
    text: `${options.label}: `,
    fontStyle: fontMedium,
    fontFamily: 'Inter',
    fill: labelFill,
    fontSize: textSm,
  });

  group.add(label);

  // REVALLE: rótulo longo em coluna estreita leva o valor para a linha de baixo, com a largura toda
  const isStacked = options.wrap !== undefined && width - label.width() < width * 0.4;

  const value = new Konva.Text({
    x: isStacked ? 0 : label.width(), // REVALLE:
    y: isStacked ? label.height() : 0, // REVALLE:
    width: isStacked ? width : width - label.width(), // REVALLE:
    fontFamily: 'Inter',
    text: options.text,
    fill: valueFill,
    wrap: options.wrap ?? 'char', // REVALLE:
    fontSize: textSm,
  });

  group.add(value);

  return group;
};

type RenderRowHeaderOptions = {
  columnWidths: number[];
  i18n: I18n;
};

const renderRowHeader = (options: RenderRowHeaderOptions) => {
  const { columnWidths, i18n } = options;

  const columnOneWidth = columnWidths[0];
  const columnTwoWidth = columnWidths[1];
  const columnThreeWidth = columnWidths[2];

  const headerRow = new Konva.Group();

  const headerFontStyling = {
    fontFamily: 'Inter',
    fontSize: 11,
    fontStyle: fontMedium,
    verticalAlign: 'middle',
    fill: textMutedForeground,
    height: tableHeaderHeight,
  };

  const header1 = new Konva.Text({
    x: rowPadding,
    width: columnOneWidth,
    text: i18n._(msg`Signer Events`),
    ...headerFontStyling,
  });
  headerRow.add(header1);

  const header2 = new Konva.Text({
    x: columnOneWidth + rowPadding,
    width: columnTwoWidth,
    text: i18n._(msg`Signature`),
    ...headerFontStyling,
  });
  headerRow.add(header2);

  const header3 = new Konva.Text({
    x: columnOneWidth + columnTwoWidth + rowPadding,
    width: columnThreeWidth,
    text: i18n._(msg`Details`),
    ...headerFontStyling,
  });
  headerRow.add(header3);

  return headerRow;
};

const columnPadding = 10;

type RenderColumnOptions = {
  recipient: CertificateRecipient;
  width: number;
  i18n: I18n;
  envelopeOwner: {
    name: string;
    email: string;
  };
};

const renderColumnOne = (options: RenderColumnOptions) => {
  const { recipient, width, i18n } = options;

  const columnGroup = new Konva.Group();

  const textSectionPadding = 8;

  const textFontStyling = {
    x: 0,
    fontFamily: 'Inter',
    wrap: 'char',
    lineHeight: 1.2,
    fill: textMutedForeground,
    width: width - columnPadding,
  };

  if (recipient.name) {
    const nameText = new Konva.Text({
      y: 0,
      text: recipient.name,
      fontSize: textBase,
      ...textFontStyling,
      fontStyle: fontMedium,
    });

    columnGroup.add(nameText);
  }

  const emailText = new Konva.Text({
    y: columnGroup.getClientRect().height,
    text: recipient.email,
    fontSize: textBase,
    ...textFontStyling,
  });

  columnGroup.add(emailText);

  const roleText = new Konva.Text({
    y: columnGroup.getClientRect().height + textSectionPadding,
    text: i18n._(RECIPIENT_ROLES_DESCRIPTION[recipient.role].roleName),
    fontSize: textSm,
    ...textFontStyling,
  });
  columnGroup.add(roleText);

  const authLabel = new Konva.Text({
    y: columnGroup.getClientRect().height + textSectionPadding,
    text: `${i18n._(msg`Authentication Level`)}:`,
    fontSize: textSm,
    fontStyle: fontMedium,
    ...textFontStyling,
  });
  columnGroup.add(authLabel);

  const authValue = new Konva.Text({
    y: columnGroup.getClientRect().height,
    text: recipient.authLevel,
    fontSize: textSm,
    ...textFontStyling,
  });
  columnGroup.add(authValue);

  return columnGroup;
};

const renderColumnTwo = (options: RenderColumnOptions) => {
  const { recipient, width, i18n } = options;

  // Column 2: Signature
  const column = new Konva.Group();

  const columnWidth = width - columnPadding;

  const isRejected = Boolean(recipient.logs.rejected);

  if (recipient.signatureField?.secondaryId) {
    // Signature container with green border
    const signatureContainer = new Konva.Group({ x: 0, y: 0 });

    const minSignatureHeight = 40;
    const maxSignatureWidth = 100;

    // Signature content
    if (recipient.signatureField?.signature?.signatureImageAsBase64) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      const img = new SkiaImage(
        recipient.signatureField?.signature?.signatureImageAsBase64,
      ) as unknown as HTMLImageElement;

      const signatureImage = new Konva.Image({
        image: img,
        x: 4,
        y: 4,
        width: maxSignatureWidth,
        height: maxSignatureWidth * (img.height / img.width),
      });

      signatureContainer.add(signatureImage);
    } else if (recipient.signatureField?.signature?.typedSignature) {
      const typedSig = new Konva.Text({
        x: 2,
        text: recipient.signatureField?.signature?.typedSignature,
        padding: 4,
        fontFamily: getSignatureFontFamily(recipient.signatureField?.signature?.typedSignature),
        fontSize: 16,
        align: 'center',
        verticalAlign: 'middle',
        width: maxSignatureWidth,
      });

      if (typedSig.getClientRect().height < minSignatureHeight) {
        typedSig.setAttrs({
          height: minSignatureHeight,
        });
      }

      signatureContainer.add(typedSig);
    } else if (recipient.revalle?.isStampOnly) {
      // REVALLE: sem desenho nem texto, a caixa diz que a marca no documento é o carimbo (não fica vazia)
      const stampOnlyLabel = new Konva.Text({
        x: 2,
        text: REVALLE_STAMP_ONLY_LABEL,
        padding: 4,
        fontFamily: 'Inter',
        fontSize: textSm,
        fill: textMutedForeground,
        align: 'center',
        verticalAlign: 'middle',
        wrap: 'word',
        width: maxSignatureWidth,
      });

      if (stampOnlyLabel.getClientRect().height < minSignatureHeight) {
        stampOnlyLabel.setAttrs({ height: minSignatureHeight });
      }

      signatureContainer.add(stampOnlyLabel);
    }

    // Do not add the signature container for rejected recipients.
    if (!isRejected) {
      column.add(signatureContainer);
    }

    const signatureHeight = Math.max(signatureContainer.getClientRect().height, minSignatureHeight);

    const signatureBorder = new Konva.Rect({
      x: 2,
      y: 2,
      width: maxSignatureWidth,
      height: signatureHeight,
      stroke: 'rgba(122, 196, 85, 0.6)',
      strokeWidth: 1,
      cornerRadius: 8,
    });
    signatureContainer.add(signatureBorder);

    const signatureShadow = new Konva.Rect({
      x: 0,
      y: 0,
      width: maxSignatureWidth + 4,
      height: signatureHeight + 4,
      stroke: 'rgba(122, 196, 85, 0.1)',
      strokeWidth: 4,
      cornerRadius: 8,
    });
    signatureContainer.add(signatureShadow);

    // Signature ID
    const sigIdLabel = new Konva.Text({
      x: 0,
      y: isRejected ? 0 : signatureHeight + 10,
      text: `${i18n._(msg`Signature ID`)}:`,
      fill: textMutedForeground,
      width: columnWidth,
      fontFamily: 'Inter',
      fontSize: textSm,
      fontStyle: fontMedium,
      lineHeight: 1.4,
    });
    column.add(sigIdLabel);

    const sigIdValue = new Konva.Text({
      x: 0,
      y: column.getClientRect().height,
      text: recipient.signatureField.secondaryId.toUpperCase(),
      fill: textMutedForeground,
      fontFamily: 'monospace',
      fontSize: textSm,
      width: columnWidth,
      wrap: 'char',
    });
    column.add(sigIdValue);
  } else {
    const naText = new Konva.Text({
      x: 0,
      y: 0,
      text: 'N/A',
      fill: textMutedForeground,
      fontFamily: 'Inter',
      fontSize: textSm,
    });
    column.add(naText);
  }

  const relevantLog = isRejected ? recipient.logs.rejected : recipient.logs.completed;

  const ipLabelAndText = renderLabelAndText({
    label: i18n._(msg`IP Address`),
    text: relevantLog?.ipAddress ?? i18n._(msg`Unknown`),
    width,
    y: column.getClientRect().height + 6,
  });
  column.add(ipLabelAndText);

  const deviceLabelAndText = renderLabelAndText({
    label: i18n._(msg`Device`),
    text: recipient.revalle?.device ?? getDevice(relevantLog?.userAgent), // REVALLE: aparelho congelado na prova
    width,
    wrap: recipient.revalle ? 'word' : undefined, // REVALLE:
    y: column.getClientRect().height + 6,
  });
  column.add(deviceLabelAndText);

  return column;
};

const renderColumnThree = (options: RenderColumnOptions) => {
  const { recipient, width, i18n, envelopeOwner } = options;

  const column = new Konva.Group();

  type DetailItem = {
    label: string;
    value: string;
    labelFill?: string;
    valueFill?: string;
    wrap?: 'word' | 'char'; // REVALLE:
    gap?: number; // REVALLE:
  };

  const itemsToRender: DetailItem[] = [
    {
      label: i18n._(msg`Sent`),
      value: recipient.logs.emailed
        ? formatRevalleDateTime(recipient.logs.emailed.createdAt)
        : recipient.logs.sent
          ? formatRevalleDateTime(recipient.logs.sent.createdAt)
          : i18n._(msg`Unknown`),
    },
    {
      label: i18n._(msg`Viewed`),
      value: recipient.logs.opened ? formatRevalleDateTime(recipient.logs.opened.createdAt) : i18n._(msg`Unknown`),
    },
  ];

  if (recipient.logs.rejected) {
    itemsToRender.push({
      label: i18n._(msg`Rejected`),
      value: formatRevalleDateTime(recipient.logs.rejected.createdAt),
      labelFill: textRejectedRed,
      valueFill: textRejectedRed,
    });
  } else if (recipient.revalle) {
    // REVALLE: com prova, o verbo do papel (igual ao /verificar) e o horário congelado
    itemsToRender.push({
      label: recipient.revalle.signedVerb,
      value: formatRevalleDateTime(recipient.revalle.signedAt),
    });
  } else {
    itemsToRender.push({
      label: i18n._(msg`Signed`),
      value: recipient.logs.completed
        ? formatRevalleDateTime(recipient.logs.completed.createdAt)
        : i18n._(msg`Unknown`),
    });
  }

  const isOwner = recipient.email.toLowerCase() === envelopeOwner.email.toLowerCase();

  itemsToRender.push({
    label: i18n._(msg`Reason`),
    value:
      recipient.signingStatus === SigningStatus.REJECTED
        ? recipient.rejectionReason || ''
        : isOwner
          ? i18n._(msg`I am the owner of this document`)
          : i18n._(RECIPIENT_ROLE_SIGNING_REASONS[recipient.role]),
  });

  // REVALLE: linhas da prova congelada, só quando ela existe
  for (const row of recipient.revalle?.rows ?? []) {
    itemsToRender.push({ ...row, wrap: 'word', gap: 5 });
  }

  for (const [index, item] of itemsToRender.entries()) {
    const labelAndText = renderLabelAndText({
      label: item.label,
      text: item.value,
      width,
      y: column.getClientRect().height + (index === 0 ? 0 : (item.gap ?? 8)), // REVALLE: gap
      labelFill: item.labelFill,
      valueFill: item.valueFill,
      wrap: item.wrap, // REVALLE:
    });
    column.add(labelAndText);
  }

  return column;
};

type RenderRowOptions = {
  recipient: CertificateRecipient;
  columnWidths: ColumnWidths;
  i18n: I18n;
  envelopeOwner: {
    name: string;
    email: string;
  };
};

const renderRow = (options: RenderRowOptions) => {
  const { recipient, columnWidths, i18n, envelopeOwner } = options;

  const rowGroup = new Konva.Group();

  const width = columnWidths[0] + columnWidths[1] + columnWidths[2];

  // Draw top border line.
  const borderLine = new Konva.Line({
    points: [0, 0, width + rowPadding * 2, 0],
    stroke: '#e5e7eb',
    strokeWidth: 1,
  });

  rowGroup.add(borderLine);

  // Column 1: Signer Events
  const columnGroup = renderColumnOne({
    recipient,
    width: columnWidths[0],
    i18n,
    envelopeOwner,
  });
  columnGroup.setAttrs({
    x: rowPadding,
    y: rowPadding,
  } satisfies Partial<Konva.GroupConfig>);
  rowGroup.add(columnGroup);

  const columnTwoGroup = renderColumnTwo({
    recipient,
    width: columnWidths[1],
    i18n,
    envelopeOwner,
  });
  columnTwoGroup.setAttrs({
    x: rowPadding + columnWidths[0],
    y: rowPadding,
  } satisfies Partial<Konva.GroupConfig>);
  rowGroup.add(columnTwoGroup);

  // Column 3: Details
  const columnThreeGroup = renderColumnThree({
    recipient,
    width: columnWidths[2],
    i18n,
    envelopeOwner,
  });
  columnThreeGroup.setAttrs({
    x: rowPadding + columnWidths[0] + columnWidths[1],
    y: rowPadding,
  } satisfies Partial<Konva.GroupConfig>);
  rowGroup.add(columnThreeGroup);

  const rowBottomPadding = new Konva.Rect({
    x: 0,
    y: rowGroup.getClientRect().height,
    width: rowGroup.getClientRect().width,
    height: rowPadding,
  });
  rowGroup.add(rowBottomPadding);

  return rowGroup;
};

// REVALLE: com hidePoweredBy o logo "Powered by" some, mas o QR continua sempre desenhado.
const renderBranding = async ({
  qrToken,
  i18n,
  hidePoweredBy,
}: {
  qrToken: string | null;
  i18n: I18n;
  hidePoweredBy: boolean;
}) => {
  const branding = new Konva.Group();

  const brandingHeight = 12;

  const text = new Konva.Text({
    x: 0,
    verticalAlign: 'middle',
    text: i18n._(msg`Signing certificate provided by`) + ':',
    fontStyle: fontMedium,
    fontFamily: 'Inter',
    fontSize: textSm,
    height: brandingHeight,
  });

  const qrSize = qrToken ? 72 : 0;

  if (!hidePoweredBy) {
    const logoPath = path.join(process.cwd(), 'public/static/logo.png');
    const logo = fs.readFileSync(logoPath);

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const img = new SkiaImage(logo) as unknown as HTMLImageElement;

    const documensoImage = new Konva.Image({
      image: img,
      height: brandingHeight,
      width: brandingHeight * (img.width / img.height),
      x: text.width() + 16,
    });

    const logoGroup = new Konva.Group({
      y: qrSize + 16,
    });
    logoGroup.add(text);
    logoGroup.add(documensoImage);

    branding.add(logoGroup);
  }

  if (qrToken) {
    const qrSvg = renderSVG(`${NEXT_PUBLIC_WEBAPP_URL()}/share/${qrToken}`, {
      ecc: 'Q',
    });

    const svgImage = await svgToPng(qrSvg);

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const qrSkiaImage = new SkiaImage(svgImage) as unknown as HTMLImageElement;
    const qrImage = new Konva.Image({
      image: qrSkiaImage,
      height: qrSize,
      width: qrSize,
      // REVALLE: sem o logo o grupo está vazio; o QR alinha à direita pela largura do grupo (mínimo = o próprio QR).
      x: Math.max(branding.getClientRect().width, qrSize) - qrSize,
      y: 0,
    });

    branding.add(qrImage);
  }

  return branding;
};

type GroupRowsIntoPagesOptions = {
  recipients: CertificateRecipient[];
  maxHeight: number;
  i18n: I18n;
  columnWidths: ColumnWidths;
  envelopeOwner: {
    name: string;
    email: string;
  };
};

const groupRowsIntoPages = (options: GroupRowsIntoPagesOptions) => {
  const { recipients, maxHeight, i18n, columnWidths, envelopeOwner } = options;

  const rowHeader = renderRowHeader({ columnWidths, i18n });
  const rowHeaderHeight = rowHeader.getClientRect().height;

  const groupedRows: Konva.Group[][] = [[]];

  let availablePageHeight = maxHeight - rowHeaderHeight;
  let currentGroupedRowIndex = 0;

  // Group rows into pages.
  for (const recipient of recipients) {
    const row = renderRow({ recipient, columnWidths, i18n, envelopeOwner });

    const rowHeight = row.getClientRect().height;

    // REVALLE: linha mais alta que a página fica na página atual se ela ainda está vazia (sem página de tabela vazia)
    if (rowHeight > availablePageHeight && groupedRows[currentGroupedRowIndex].length > 0) {
      currentGroupedRowIndex++;
      groupedRows[currentGroupedRowIndex] = [row];
      availablePageHeight = maxHeight - rowHeaderHeight;
    } else {
      groupedRows[currentGroupedRowIndex].push(row);
    }

    // Reduce available height by the row height.
    availablePageHeight -= rowHeight;
  }

  return groupedRows;
};

type RenderTablesOptions = {
  groupedRows: Konva.Group[][];
  columnWidths: ColumnWidths;
  i18n: I18n;
};

const renderTables = (options: RenderTablesOptions) => {
  const { groupedRows, columnWidths, i18n } = options;

  const tables: Konva.Group[] = [];

  // Render the rows for each page.
  for (const rows of groupedRows) {
    const table = new Konva.Group();
    const tableHeader = renderRowHeader({ columnWidths, i18n });

    table.add(tableHeader);

    for (const row of rows) {
      row.setAttrs({
        x: 0,
        y: table.getClientRect().height,
      } satisfies Partial<Konva.GroupConfig>);

      table.add(row);
    }

    // Add table background and border.
    const tableClientRect = table.getClientRect();
    const cardRect = new Konva.Rect({
      x: tableClientRect.x,
      y: tableClientRect.y,
      width: tableClientRect.width,
      height: tableClientRect.height,
      stroke: '#e5e7eb',
      strokeWidth: 1.5,
      cornerRadius: 8,
    });
    table.add(cardRect);

    tables.push(table);
  }

  return tables;
};

// REVALLE: SHA-256 do original (e a conta da NF aprovada) sob a nota de fuso, quebrando na largura da tabela.
const revalleHeaderTop = pageTopMargin - 8;

const renderRevalleHeaderLines = (lines: RevalleCertificateHeaderLine[], x: number, width: number) => {
  const group = new Konva.Group({ x, y: revalleHeaderTop });
  let y = 0;

  for (const line of lines) {
    const text = new Konva.Text({
      y,
      width,
      text: line.text,
      wrap: line.wrap,
      fontFamily: 'Inter',
      fontSize: textXs,
      lineHeight: 1.2,
      fill: textMutedForeground,
    });

    group.add(text);
    y += text.height();
  }

  return { group, height: y };
};

// REVALLE: atribuição exigida pela licença da base DB-IP Lite (mesmo texto do /privacidade).
const renderRevalleDbIpFooter = (x: number, width: number, pageHeight: number) =>
  new Konva.Text({
    x,
    y: pageHeight - textXs - 10,
    width,
    align: 'right',
    text: 'IP Geolocation by DB-IP (https://db-ip.com)',
    fontFamily: 'Inter',
    fontSize: textXs,
    fill: textMutedForegroundLight,
  });

export async function renderCertificate({
  recipients,
  envelopeId,
  qrToken,
  hidePoweredBy,
  i18n,
  envelopeOwner,
  pageWidth,
  pageHeight,
  revalleHeaderLines = [], // REVALLE:
}: GenerateCertificateOptions) {
  ensureFontLibrary();

  const minimumMargin = 10;

  const tableWidth = Math.min(pageWidth - minimumMargin * 2, contentMaxWidth);
  const tableContentWidth = tableWidth - rowPadding * 2;
  const margin = (pageWidth - tableWidth) / 2;

  const columnOneWidth = (tableContentWidth * columnWidthPercentages[0]) / 100;
  const columnTwoWidth = (tableContentWidth * columnWidthPercentages[1]) / 100;
  const columnThreeWidth = (tableContentWidth * columnWidthPercentages[2]) / 100;

  const columnWidths: ColumnWidths = [columnOneWidth, columnTwoWidth, columnThreeWidth];

  // Helper to render a Konva stage to a PNG buffer
  let stage: Konva.Stage | null = new Konva.Stage({ width: pageWidth, height: pageHeight });

  // REVALLE: a tabela desce o tanto que as linhas do hash ocupam; sem hash (documento antigo), nada muda
  const revalleHeaderShift =
    revalleHeaderLines.length > 0 ? renderRevalleHeaderLines(revalleHeaderLines, margin, tableWidth).height : 0;
  const hasRevalleProof = recipients.some((recipient) => Boolean(recipient.revalle)); // REVALLE:

  const maxTableHeight = pageHeight - pageTopMargin - pageBottomMargin - revalleHeaderShift; // REVALLE: - revalleHeaderShift

  const groupedRows = groupRowsIntoPages({
    recipients,
    maxHeight: maxTableHeight,
    columnWidths,
    i18n,
    envelopeOwner,
  });

  const tables = renderTables({ groupedRows, columnWidths, i18n });

  const brandingGroup = await renderBranding({ qrToken, i18n, hidePoweredBy });
  const brandingRect = brandingGroup.getClientRect();
  const brandingTopPadding = 24;
  // REVALLE: sem logo e sem QR (qrToken nulo) não há nada a desenhar.
  const showBranding = !hidePoweredBy || Boolean(qrToken);

  const pages: Uint8Array[] = [];

  let isQrPlaced = false;

  // Add a table to each page.
  for (const [index, table] of tables.entries()) {
    stage.destroyChildren();
    const page = new Konva.Layer();

    const group = new Konva.Group();

    const titleText = new Konva.Text({
      x: margin,
      y: 0,
      height: pageTopMargin,
      verticalAlign: 'middle',
      text: i18n._(msg`Signing Certificate`),
      fontFamily: 'Inter',
      fontSize: titleFontSize,
      fontStyle: '700',
    });

    table.setAttrs({
      x: margin,
      y: pageTopMargin + revalleHeaderShift, // REVALLE: + revalleHeaderShift
    } satisfies Partial<Konva.GroupConfig>);

    // REVALLE: fuso das datas do certificado.
    const zoneText = new Konva.Text({
      x: margin,
      y: pageTopMargin - 20,
      text: REVALLE_TIME_ZONE_NOTE,
      fontFamily: 'Inter',
      fontSize: textXs,
      fill: textMutedForegroundLight,
    });

    group.add(titleText);
    group.add(zoneText);
    group.add(table);

    // REVALLE: SHA-256 do original em todas as páginas da tabela
    if (revalleHeaderLines.length > 0) {
      group.add(renderRevalleHeaderLines(revalleHeaderLines, margin, tableWidth).group);
    }

    // Add QR code and branding on the last page if there is space.
    if (index === tables.length - 1 && showBranding) {
      const remainingHeight = pageHeight - group.getClientRect().height - pageBottomMargin;

      if (brandingRect.height + brandingTopPadding <= remainingHeight) {
        brandingGroup.setAttrs({
          x: pageWidth - brandingRect.width - margin,
          y: group.getClientRect().height + brandingTopPadding,
        } satisfies Partial<Konva.GroupConfig>);

        page.add(brandingGroup);
        isQrPlaced = true;
      }
    }

    const footerText = new Konva.Text({
      x: margin,
      y: pageHeight - textXs - 10,
      text: `${i18n._(msg`Envelope ID`)}: ${envelopeId}`,
      fontFamily: 'Inter',
      fontSize: textXs,
      fill: textMutedForegroundLight,
    });
    page.add(footerText);

    if (hasRevalleProof) {
      page.add(renderRevalleDbIpFooter(margin, tableWidth, pageHeight)); // REVALLE:
    }

    page.add(group);
    stage.add(page);

    // Export the page and save it.
    const canvas = page.canvas._canvas as unknown as Canvas; // eslint-disable-line @typescript-eslint/consistent-type-assertions
    const buffer = await canvas.toBuffer('pdf');
    pages.push(new Uint8Array(buffer));
  }

  // Need to create an empty page for the QR code if it hasn't been placed yet.
  if (showBranding && !isQrPlaced) {
    const page = new Konva.Layer();

    brandingGroup.setAttrs({
      x: pageWidth - brandingRect.width - margin,
      y: pageTopMargin / 2, // Less padding since there's nothing else on this page.
    } satisfies Partial<Konva.GroupConfig>);

    const overflowFooterText = new Konva.Text({
      x: margin,
      y: pageHeight - textXs - 10,
      text: `${i18n._(msg`Envelope ID`)}: ${envelopeId}`,
      fontFamily: 'Inter',
      fontSize: textXs,
      fill: textMutedForegroundLight,
    });
    page.add(overflowFooterText);

    if (hasRevalleProof) {
      page.add(renderRevalleDbIpFooter(margin, tableWidth, pageHeight)); // REVALLE:
    }

    page.add(brandingGroup);
    stage.add(page);

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const canvas = page.canvas._canvas as unknown as Canvas;
    const buffer = await canvas.toBuffer('pdf');

    pages.push(new Uint8Array(buffer));
  }

  stage.destroy();
  stage = null;

  return pages;
}
