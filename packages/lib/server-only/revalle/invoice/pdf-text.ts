import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * Texto de cada página (até `maxPages`) com o `getTextContent` do pdfjs (build legacy, como `ai/pdf-to-images.ts`).
 * PDF escaneado devolve páginas vazias. PDF ilegível ou protegido devolve `[]` (a detecção trata como sem texto).
 */
export const extractPdfText = async (bytes: Uint8Array, maxPages = 5): Promise<string[]> => {
  // O pdfjs pode transferir o buffer para o worker: trabalha numa cópia.
  const task = pdfjsLib.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });

  let pdf: Awaited<typeof task.promise> | undefined;

  try {
    pdf = await task.promise;

    const pages: string[] = [];
    const total = Math.min(pdf.numPages, maxPages);

    for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();

      pages.push(
        content.items
          .map((item) => ('str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : ''))
          .join('')
          .replace(/[ \t]+/g, ' ')
          .trim(),
      );

      page.cleanup();
    }

    return pages;
  } catch {
    return [];
  } finally {
    await (pdf ? pdf.destroy() : task.destroy()).catch(() => undefined);
  }
};
