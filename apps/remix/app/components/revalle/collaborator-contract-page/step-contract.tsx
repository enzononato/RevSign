import type { SignatureRect } from '@documenso/lib/revalle/collaborator-contract-rect';
import { cn } from '@documenso/ui/lib/utils';
import { Button } from '@documenso/ui/primitives/button';
import { Input } from '@documenso/ui/primitives/input';
import { Label } from '@documenso/ui/primitives/label';
import { Trans, useLingui } from '@lingui/react/macro';
import { FileTextIcon, MonitorIcon, UploadIcon } from 'lucide-react';
import { type DragEvent, useId, useRef, useState } from 'react';

import type { PdfDocumentState } from './contract-pdf';
import { type BoxKind, type ContractBoxes, SignatureBoxesEditor } from './signature-boxes';

// REVALLE (v.22): passo 1 do assistente: título, o PDF e os dois quadros de assinatura.

export const CONTRACT_PDF_MAX_MB = 10;

export type StepContractProps = {
  title: string;
  onTitleChange: (title: string) => void;
  titleError: string | null;
  fileName: string | null;
  hasPdf: boolean;
  pdfState: PdfDocumentState;
  pdfError: string | null;
  isUploading: boolean;
  onFile: (file: File) => void;
  boxes: ContractBoxes | null;
  onBoxChange: (kind: BoxKind, rect: SignatureRect) => void;
  currentPage: number;
  onPageChange: (page: number) => void;
};

export const StepContract = ({
  title,
  onTitleChange,
  titleError,
  fileName,
  hasPdf,
  pdfState,
  pdfError,
  isUploading,
  onFile,
  boxes,
  onBoxChange,
  currentPage,
  onPageChange,
}: StepContractProps) => {
  const { t } = useLingui();

  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const fileId = useId();
  const [isDragging, setIsDragging] = useState(false);

  const pickFile = (files: FileList | null) => {
    const file = files?.[0];

    if (file) {
      onFile(file);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    pickFile(event.dataTransfer.files);
  };

  return (
    <div className="flex flex-col gap-6" data-testid="wizard-step-contract">
      <div className="flex max-w-xl flex-col gap-1.5">
        <Label htmlFor={titleId}>
          <Trans>Título do contrato</Trans>
        </Label>
        <Input
          id={titleId}
          value={title}
          maxLength={255}
          placeholder={t`Por exemplo: Termo de confidencialidade 2026`}
          aria-invalid={titleError ? true : undefined}
          aria-describedby={titleError ? `${titleId}-error` : undefined}
          onChange={(event) => onTitleChange(event.target.value)}
          data-testid="contract-title"
        />
        {titleError && (
          <p id={`${titleId}-error`} className="text-destructive text-sm" role="alert">
            {titleError}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={fileId}>
          <Trans>PDF do contrato</Trans>
        </Label>

        {/* biome-ignore lint/a11y/noStaticElementInteractions: área de soltar arquivo; o botão ao lado faz o mesmo pelo teclado */}
        <div
          className={cn(
            'flex flex-col items-start gap-3 rounded-xl border-[1.5px] border-dashed p-4 transition-colors sm:flex-row sm:items-center',
            isDragging ? 'border-primary bg-accent' : 'border-border bg-muted/30',
            pdfError && 'border-destructive',
          )}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
          data-testid="contract-pdf-drop"
        >
          <FileTextIcon className="h-8 w-8 shrink-0 text-muted-foreground" aria-hidden />

          <div className="min-w-0 flex-1 text-sm">
            {fileName || hasPdf ? (
              <p className="truncate font-semibold" data-testid="contract-pdf-name">
                {fileName ?? t`PDF do rascunho`}
              </p>
            ) : (
              <p className="font-semibold">
                <Trans>Arraste o PDF até aqui ou escolha o arquivo.</Trans>
              </p>
            )}
            <p className="text-muted-foreground">
              <Trans>Um arquivo PDF, até {CONTRACT_PDF_MAX_MB} MB.</Trans>
            </p>
          </div>

          <input
            ref={inputRef}
            id={fileId}
            type="file"
            accept="application/pdf,.pdf"
            className="sr-only"
            onChange={(event) => {
              pickFile(event.target.files);
              event.target.value = '';
            }}
            data-testid="contract-pdf-input"
          />

          <Button
            type="button"
            variant="outline"
            loading={isUploading}
            onClick={() => inputRef.current?.click()}
            data-testid="contract-pdf-choose"
          >
            {!isUploading && <UploadIcon className="mr-2 h-4 w-4" aria-hidden />}
            {isUploading ? (
              <Trans>Enviando o PDF…</Trans>
            ) : hasPdf ? (
              <Trans>Trocar o PDF</Trans>
            ) : (
              <Trans>Escolher PDF</Trans>
            )}
          </Button>
        </div>

        {pdfError && (
          <p className="text-destructive text-sm" role="alert" data-testid="contract-pdf-error">
            {pdfError}
          </p>
        )}
      </div>

      {hasPdf && (
        <div className="flex flex-col gap-3">
          <div>
            <h3 className="font-display font-extrabold text-[17px]">
              <Trans>Onde cada um assina</Trans>
            </h3>
            <p className="text-muted-foreground text-sm">
              <Trans>
                Os dois quadros são obrigatórios. O representante assina no azul; cada colaborador, no verde.
              </Trans>
            </p>
          </div>

          {/* No celular não dá para posicionar com precisão: só o aviso. */}
          <div
            className="flex items-start gap-3 rounded-xl bg-warning-bg p-4 text-sm text-warning-text md:hidden"
            data-testid="contract-small-screen"
          >
            <MonitorIcon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
            <p className="font-semibold">
              <Trans>Use uma tela maior para posicionar as assinaturas</Trans>
            </p>
          </div>

          <div className="hidden md:block">
            {pdfState.status === 'ready' && boxes ? (
              <SignatureBoxesEditor
                pdf={pdfState.pdf}
                boxes={boxes}
                onChange={onBoxChange}
                currentPage={currentPage}
                onPageChange={onPageChange}
              />
            ) : pdfState.status === 'error' ? (
              <p className="rounded-xl bg-danger-bg p-4 text-destructive text-sm" role="alert">
                <Trans>Não foi possível abrir a prévia do PDF. Escolha o arquivo de novo.</Trans>
              </p>
            ) : (
              <div
                className="flex aspect-[1/1.2] max-w-[720px] animate-pulse items-center justify-center rounded-md bg-muted text-muted-foreground text-sm"
                data-testid="contract-preview-loading"
              >
                <Trans>Carregando a prévia…</Trans>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
