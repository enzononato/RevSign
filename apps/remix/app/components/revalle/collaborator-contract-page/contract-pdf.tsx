import { Trans } from '@lingui/react/macro';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { type ReactNode, useEffect, useRef, useState } from 'react';

// REVALLE (v.22): prévia do PDF do contrato no assistente, uma página por vez (pdf.js, como o visualizador do editor).
// O pdf.js só carrega no navegador (import dinâmico), nunca na renderização do servidor.

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let pdfJsPromise: Promise<PdfJs> | null = null;

const loadPdfJs = () => {
  pdfJsPromise ??= Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.mjs?url'),
  ])
    .then(([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

      return pdfjs;
    })
    .catch((error) => {
      pdfJsPromise = null;

      throw error;
    });

  return pdfJsPromise;
};

/** O arquivo escolhido agora (bytes) ou o PDF do rascunho (URL). Guarde em estado: a identidade dispara a leitura. */
export type PdfSource = { kind: 'bytes'; data: Uint8Array } | { kind: 'url'; url: string };

export type PdfDocumentState =
  | { status: 'idle' | 'loading' | 'error'; pdf: null }
  | { status: 'ready'; pdf: PDFDocumentProxy };

export const usePdfDocument = (source: PdfSource | null): PdfDocumentState => {
  const [state, setState] = useState<PdfDocumentState>({ status: 'idle', pdf: null });

  useEffect(() => {
    if (!source) {
      setState({ status: 'idle', pdf: null });

      return;
    }

    let isCancelled = false;
    let loaded: PDFDocumentProxy | null = null;

    setState({ status: 'loading', pdf: null });

    void (async () => {
      try {
        const pdfjs = await loadPdfJs();

        let data: Uint8Array;

        if (source.kind === 'bytes') {
          // O pdf.js toma posse do buffer: vai uma cópia.
          data = source.data.slice();
        } else {
          const response = await fetch(source.url, { credentials: 'same-origin' });

          if (!response.ok) {
            throw new Error(`PDF ${response.status}`);
          }

          data = new Uint8Array(await response.arrayBuffer());
        }

        const pdf = await pdfjs.getDocument({ data, cMapUrl: '/static/cmaps/' }).promise;

        if (isCancelled) {
          await pdf.destroy();

          return;
        }

        loaded = pdf;
        setState({ status: 'ready', pdf });
      } catch {
        if (!isCancelled) {
          setState({ status: 'error', pdf: null });
        }
      }
    })();

    return () => {
      isCancelled = true;

      if (loaded) {
        void loaded.destroy();
      }
    };
  }, [source]);

  return state;
};

/** Conta as páginas de um PDF escolhido, antes de subir (e confere que o pdf.js consegue abrir). */
export const countPdfPages = async (bytes: Uint8Array): Promise<number> => {
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), cMapUrl: '/static/cmaps/' }).promise;

  try {
    return pdf.numPages;
  } finally {
    await pdf.destroy();
  }
};

export type PdfPageViewProps = {
  pdf: PDFDocumentProxy;
  /** Começa em 1. */
  pageNumber: number;
  /** Desenhado por cima da página, no mesmo tamanho (os quadros de assinatura). */
  children?: ReactNode;
  overlayRef?: React.Ref<HTMLDivElement>;
  className?: string;
  label: string;
};

/**
 * Uma página do PDF na largura do contêiner, como aparece na tela (com a rotação da página), e uma camada por cima do
 * mesmo tamanho. Os quadros em % dessa camada são os % da página vista na tela, a convenção do servidor.
 */
export const PdfPageView = ({ pdf, pageNumber, children, overlayRef, className, label }: PdfPageViewProps) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [width, setWidth] = useState(0);
  const [ratio, setRatio] = useState<number | null>(null);
  const [isRendering, setIsRendering] = useState(true);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    const wrapper = wrapperRef.current;

    if (!wrapper) {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.round(entry.contentRect.width));
    });

    observer.observe(wrapper);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas || width === 0) {
      return;
    }

    let isCancelled = false;
    let task: RenderTask | null = null;

    setIsRendering(true);
    setHasError(false);

    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        const base = page.getViewport({ scale: 1 });
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: (width / base.width) * pixelRatio });
        const context = canvas.getContext('2d');

        if (isCancelled || !context) {
          return;
        }

        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        setRatio(base.height / base.width);

        task = page.render({ canvasContext: context, viewport, canvas });
        await task.promise;

        if (!isCancelled) {
          setIsRendering(false);
        }
      } catch (error) {
        if (!isCancelled && (error as { name?: string })?.name !== 'RenderingCancelledException') {
          setHasError(true);
          setIsRendering(false);
        }
      }
    })();

    return () => {
      isCancelled = true;
      task?.cancel();
    };
  }, [pdf, pageNumber, width]);

  return (
    <div ref={wrapperRef} className={className}>
      <div
        className="relative w-full overflow-hidden rounded-md bg-white shadow-card ring-1 ring-border"
        style={{ aspectRatio: ratio ? `1 / ${ratio}` : '1 / 1.414' }}
      >
        <canvas
          ref={canvasRef}
          className="absolute inset-0 block h-full w-full select-none"
          role="img"
          aria-label={label}
          data-testid="contract-pdf-page"
        />

        {isRendering && (
          <div className="absolute inset-0 animate-pulse bg-muted/60" aria-hidden data-testid="contract-pdf-loading" />
        )}

        {hasError && (
          <p className="absolute inset-0 flex items-center justify-center p-6 text-center text-destructive text-sm">
            <Trans>Não foi possível mostrar esta página.</Trans>
          </p>
        )}

        <div ref={overlayRef} className="absolute inset-0" data-testid="contract-pdf-overlay">
          {children}
        </div>
      </div>
    </div>
  );
};
