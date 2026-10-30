import { prisma } from '@documenso/prisma';

import type { InvoiceDetection } from '../../../revalle/invoice/detect-invoice';
import { detectInvoice } from '../../../revalle/invoice/detect-invoice';
import { sha256Hex } from '../../../revalle/sha256';
import { getFileServerSide } from '../../../universal/upload/get-file.server';
import { extractPdfText } from './pdf-text';

export type InvoiceEnvelopeFile = {
  envelopeItemId: string;
  bytes: Uint8Array;
  sha256: string;
};

/** Mesmo critério de `detectInvoice`: menos que isso por página = sem texto (escaneado). */
const MIN_CHARS_PER_PAGE = 50;

/**
 * Bytes ORIGINAIS (`initialData`, o PDF que o remetente subiu, nunca o assinado) de cada item, na ordem do envelope.
 */
export const loadEnvelopeFiles = async (envelopeId: string): Promise<InvoiceEnvelopeFile[]> => {
  const items = await prisma.envelopeItem.findMany({
    where: { envelopeId },
    orderBy: { order: 'asc' },
    select: { id: true, documentData: { select: { type: true, initialData: true } } },
  });

  return await Promise.all(
    items.map(async (item) => {
      const bytes = await getFileServerSide({ type: item.documentData.type, data: item.documentData.initialData });

      return { envelopeItemId: item.id, bytes, sha256: sha256Hex(bytes) };
    }),
  );
};

/**
 * Chave do conjunto de arquivos: a SHA-256 do próprio PDF quando há um só (o caso comum, e o cache vale entre
 * documentos com o mesmo arquivo); com vários, a SHA-256 da lista ordenada das SHA-256. `null` sem arquivo.
 */
export const filesKey = (files: InvoiceEnvelopeFile[]): string | null => {
  if (files.length === 0) {
    return null;
  }

  if (files.length === 1) {
    return files[0].sha256;
  }

  const sorted = files.map((file) => file.sha256).sort();

  return sha256Hex(new TextEncoder().encode(sorted.join('\n')));
};

export type InvoiceFileContent = {
  file: InvoiceEnvelopeFile;
  pages: string[];
  /** Sem texto aproveitável (PDF escaneado): para a IA vai o próprio PDF. */
  isSparse: boolean;
  /** Detecção só deste arquivo: só arquivos YES vão para a IA (os outros podem ser contratos com dados pessoais). */
  detection: InvoiceDetection;
};

export const readFilesContent = async (files: InvoiceEnvelopeFile[], maxPages = 5): Promise<InvoiceFileContent[]> => {
  const contents: InvoiceFileContent[] = [];

  for (const file of files) {
    const pages = await extractPdfText(file.bytes, maxPages);
    const chars = pages.reduce((total, page) => total + page.replace(/\s/g, '').length, 0);

    contents.push({
      file,
      pages,
      isSparse: pages.length === 0 || chars / pages.length < MIN_CHARS_PER_PAGE,
      detection: detectInvoice(pages),
    });
  }

  return contents;
};
