import { prisma } from '@documenso/prisma';

import { detectBoleto } from '../../../revalle/invoice/boleto';
import type { InvoiceDetection } from '../../../revalle/invoice/detect-invoice';
import { detectInvoice } from '../../../revalle/invoice/detect-invoice';
import { sha256Hex } from '../../../revalle/sha256';
import { getFileServerSide } from '../../../universal/upload/get-file.server';
import { extractPdfText } from './pdf-text';

export type InvoiceEnvelopeFile = {
  envelopeItemId: string;
  /** Fase 9: ordem e título do arquivo no envio (a posição da nota e o nome dela nas mensagens). */
  order: number;
  title: string;
  bytes: Uint8Array;
  sha256: string;
};

const ITEM_SELECT = {
  id: true,
  order: true,
  title: true,
  documentData: { select: { type: true, initialData: true } },
} as const;

const toEnvelopeFile = async (item: {
  id: string;
  order: number;
  title: string;
  documentData: { type: Parameters<typeof getFileServerSide>[0]['type']; initialData: string };
}): Promise<InvoiceEnvelopeFile> => {
  const bytes = await getFileServerSide({ type: item.documentData.type, data: item.documentData.initialData });

  return { envelopeItemId: item.id, order: item.order, title: item.title, bytes, sha256: sha256Hex(bytes) };
};

/** Mesmo critério de `detectInvoice`: menos que isso por página = sem texto (escaneado). */
const MIN_CHARS_PER_PAGE = 50;

/**
 * Bytes ORIGINAIS (`initialData`, o PDF que o remetente subiu, nunca o assinado) de cada item, na ordem do envelope.
 */
export const loadEnvelopeFiles = async (envelopeId: string): Promise<InvoiceEnvelopeFile[]> => {
  const items = await prisma.envelopeItem.findMany({
    where: { envelopeId },
    orderBy: [{ order: 'asc' }, { id: 'asc' }],
    select: ITEM_SELECT,
  });

  return await Promise.all(items.map(toEnvelopeFile));
};

/** Fase 9: os bytes ORIGINAIS de um arquivo só (a leitura da IA de uma nota). Lança se o arquivo não existe mais. */
export const loadEnvelopeFile = async (envelopeItemId: string): Promise<InvoiceEnvelopeFile> =>
  await toEnvelopeFile(
    await prisma.envelopeItem.findUniqueOrThrow({ where: { id: envelopeItemId }, select: ITEM_SELECT }),
  );

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
  /** Fase 9: boleto pelo texto (linha digitável válida ou marcas), com a linha quando achou. */
  boleto: { isBoleto: boolean; digitableLine: string | null };
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
      boleto: detectBoleto(pages),
    });
  }

  return contents;
};
