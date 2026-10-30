import { PDFDocument } from '@cantoo/pdf-lib';

/** Só as primeiras `maxPages` páginas do PDF (o que vai para a IA no caso escaneado). Falha na leitura = o original. */
export const firstPagesPdf = async (bytes: Uint8Array, maxPages = 5): Promise<Uint8Array> => {
  try {
    const source = await PDFDocument.load(bytes, { ignoreEncryption: true });

    if (source.getPageCount() <= maxPages) {
      return bytes;
    }

    const trimmed = await PDFDocument.create();
    const pages = await trimmed.copyPages(
      source,
      Array.from({ length: maxPages }, (_, index) => index),
    );

    for (const page of pages) {
      trimmed.addPage(page);
    }

    return await trimmed.save();
  } catch {
    return bytes;
  }
};
