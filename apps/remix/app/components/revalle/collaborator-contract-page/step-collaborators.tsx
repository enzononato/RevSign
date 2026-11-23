import {
  MAX_COLLABORATOR_ROWS,
  type PreviewResult,
  parseCollaboratorTable,
  parseCollaboratorText,
} from '@documenso/lib/revalle/collaborator-rows';
import { maskCpf } from '@documenso/lib/revalle/cpf';
import { escapeCsvCell } from '@documenso/lib/revalle/invoice/export-csv';
import { trpc } from '@documenso/trpc/react';
import { cn } from '@documenso/ui/lib/utils';
import { Button } from '@documenso/ui/primitives/button';
import { Checkbox } from '@documenso/ui/primitives/checkbox';
import { Label } from '@documenso/ui/primitives/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@documenso/ui/primitives/tabs';
import { Textarea } from '@documenso/ui/primitives/textarea';
import { Trans, useLingui } from '@lingui/react/macro';
import { CheckIcon, DownloadIcon, FileSpreadsheetIcon, Loader2Icon, UploadIcon, XIcon } from 'lucide-react';
import { type DragEvent, type MutableRefObject, useEffect, useId, useRef, useState } from 'react';

import { downloadText, errorMessage, formatCount } from './contract-ui';
import { readSpreadsheetFile, SpreadsheetError } from './read-spreadsheet';

// REVALLE (v.22): passo 3 do assistente: a lista de colaboradores, colada ou de um arquivo, conferida no servidor
// (`previewRows`) com linhas verdes (prontas) e vermelhas (com erro).

export type ListMode = 'paste' | 'file';

export type StepCollaboratorsProps = {
  mode: ListMode;
  onModeChange: (mode: ListMode) => void;
  text: string;
  onTextChange: (text: string) => void;
  fileName: string | null;
  onFileName: (name: string | null) => void;
  preview: PreviewResult | null;
  /** De onde veio a prévia mostrada: a lista colada ou o arquivo. */
  previewOrigin: ListMode | null;
  /** O texto colado que gerou a prévia (para saber se a caixa mudou depois). */
  previewText: string | null;
  onPreview: (preview: PreviewResult | null, origin: ListMode | null, text: string | null) => void;
  /** O assistente confere a caixa na hora (Continuar com a lista mudada), sem esperar a pausa. */
  checkNowRef: MutableRefObject<(() => Promise<PreviewResult | null>) | null>;
  /** Avisa o assistente enquanto a conferência roda (o Continuar espera). */
  onCheckingChange: (isChecking: boolean) => void;
  /** Rascunho retomado: a lista não fica guardada. */
  isResumed: boolean;
  error: string | null;
};

const PASTE_DEBOUNCE_MS = 700;

export const StepCollaborators = ({
  mode,
  onModeChange,
  text,
  onTextChange,
  fileName,
  onFileName,
  preview,
  previewOrigin,
  previewText,
  onPreview,
  checkNowRef,
  onCheckingChange,
  isResumed,
  error,
}: StepCollaboratorsProps) => {
  const { t } = useLingui();

  const textId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);
  // O último texto mandado para a conferência. Começa com o da prévia: voltar ao passo só confere de novo se a caixa
  // mudou desde então.
  const checkedTextRef = useRef<string | null>(preview && previewOrigin === 'paste' ? previewText : null);

  const [checkError, setCheckError] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isReadingFile, setIsReadingFile] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const previewRows = trpc.revalle.collaboratorContract.page.previewRows.useMutation({
    meta: { doNotInvalidateQueryOnMutation: true },
  });

  const tooManyMessage = t`A lista tem mais de ${formatCount(MAX_COLLABORATOR_ROWS)} linhas. Divida em partes de até ${formatCount(MAX_COLLABORATOR_ROWS)} e crie um contrato para cada parte.`;

  const setChecking = (value: boolean) => {
    setIsChecking(value);
    onCheckingChange(value);
  };

  /** Confere a lista no servidor; respostas atrasadas (a pessoa já colou outra) são ignoradas. */
  const check = async (input: { text: string } | { rows: string[][] }): Promise<PreviewResult | null> => {
    const request = ++requestRef.current;
    const origin: ListMode = 'text' in input ? 'paste' : 'file';
    const sourceText = 'text' in input ? input.text : null;

    if (sourceText !== null) {
      checkedTextRef.current = sourceText;
    }

    setCheckError(null);

    // Conta as linhas aqui antes de mandar (o servidor recusa acima de 3.000).
    try {
      const parsed = 'text' in input ? parseCollaboratorText(input.text) : parseCollaboratorTable(input.rows);

      if (parsed.length === 0) {
        onPreview(null, null, null);
        setCheckError(t`Não encontramos nenhuma linha com nome, e-mail e CPF.`);

        return null;
      }
    } catch {
      onPreview(null, null, null);
      setCheckError(tooManyMessage);

      return null;
    }

    setChecking(true);

    try {
      const result = await previewRows.mutateAsync(input);

      if (request !== requestRef.current) {
        return null;
      }

      onPreview(result, origin, sourceText);

      return result;
    } catch (err) {
      if (request === requestRef.current) {
        onPreview(null, null, null);
        setCheckError(errorMessage(err, t`Não foi possível conferir a lista. Tente de novo.`));
      }

      return null;
    } finally {
      if (request === requestRef.current) {
        setChecking(false);
      }
    }
  };

  // Colar confere sozinho, depois de uma pausa (sem clicar em nada).
  useEffect(() => {
    if (mode !== 'paste') {
      return;
    }

    if (text === checkedTextRef.current) {
      return;
    }

    // Caixa esvaziada: some a prévia da lista colada (a do arquivo fica).
    if (text.trim() === '') {
      checkedTextRef.current = text;
      requestRef.current += 1;
      setChecking(false);
      setCheckError(null);

      if (previewOrigin !== 'file') {
        onPreview(null, null, null);
      }

      return;
    }

    const timer = setTimeout(() => void check({ text }), PASTE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [text, mode]);

  checkNowRef.current = () => check({ text });

  useEffect(
    () => () => {
      checkNowRef.current = null;
    },
    [],
  );

  const onFile = async (file: File | undefined) => {
    if (!file) {
      return;
    }

    onFileName(file.name);
    onPreview(null, null, null);
    checkedTextRef.current = null;
    setCheckError(null);
    setIsReadingFile(true);

    let rows: string[][];

    try {
      rows = await readSpreadsheetFile(file);
    } catch (err) {
      const code = err instanceof SpreadsheetError ? err.code : 'UNREADABLE';

      setCheckError(
        code === 'OLD_EXCEL'
          ? t`Arquivos .xls antigos não são lidos. No Excel, salve como .xlsx ou .csv e escolha de novo.`
          : code === 'UNSUPPORTED'
            ? t`Escolha um arquivo .xlsx ou .csv.`
            : code === 'EMPTY'
              ? t`O arquivo está vazio. Confira se a lista está na primeira aba da planilha.`
              : t`Não foi possível ler o arquivo. Confira se ele abre no Excel e tente de novo.`,
      );

      return;
    } finally {
      setIsReadingFile(false);
    }

    await check({ rows });
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    void onFile(event.dataTransfer.files[0]);
  };

  const shownError = checkError ?? error;

  return (
    <div className="flex flex-col gap-5" data-testid="wizard-step-collaborators">
      <div className="text-muted-foreground text-sm">
        <p>
          <Trans>
            Colunas aceitas, em qualquer ordem: nome, e-mail e CPF. Sem cabeçalho, a ordem é nome, e-mail, CPF. O CPF
            pode vir com ou sem pontuação. Até {formatCount(MAX_COLLABORATOR_ROWS)} linhas.
          </Trans>
        </p>
        {isResumed && !preview && (
          <p className="mt-2 font-semibold text-warning-text" data-testid="collaborators-resumed-note">
            <Trans>Por segurança, a lista não fica guardada no rascunho. Cole ou suba a lista de novo.</Trans>
          </p>
        )}
      </div>

      <Tabs value={mode} onValueChange={(value) => onModeChange(value as ListMode)}>
        <TabsList>
          <TabsTrigger value="paste" data-testid="collaborators-tab-paste">
            <Trans>Colar da planilha</Trans>
          </TabsTrigger>
          <TabsTrigger value="file" data-testid="collaborators-tab-file">
            <Trans>Subir arquivo</Trans>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="paste" className="mt-4">
          <Label htmlFor={textId} className="sr-only">
            <Trans>Lista de colaboradores</Trans>
          </Label>
          <Textarea
            id={textId}
            value={text}
            rows={8}
            spellCheck={false}
            className="font-mono text-[13px]"
            placeholder={t`Copie as colunas nome, e-mail e CPF da planilha e cole aqui.`}
            onChange={(event) => onTextChange(event.target.value)}
            data-testid="collaborators-paste"
          />
        </TabsContent>

        <TabsContent value="file" className="mt-4">
          {/* biome-ignore lint/a11y/noStaticElementInteractions: área de soltar arquivo; o botão ao lado faz o mesmo pelo teclado */}
          <div
            className={cn(
              'flex flex-col items-start gap-3 rounded-xl border-[1.5px] border-dashed p-4 sm:flex-row sm:items-center',
              isDragging ? 'border-primary bg-accent' : 'border-border bg-muted/30',
            )}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={onDrop}
          >
            <FileSpreadsheetIcon className="h-8 w-8 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1 text-sm">
              <p className="truncate font-semibold" data-testid="collaborators-file-name">
                {fileName ?? <Trans>Arraste a planilha até aqui ou escolha o arquivo.</Trans>}
              </p>
              <p className="text-muted-foreground">
                <Trans>.xlsx ou .csv. A lista é lida na primeira aba.</Trans>
              </p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="sr-only"
              aria-label={t`Arquivo da lista de colaboradores`}
              onChange={(event) => {
                void onFile(event.target.files?.[0]);
                event.target.value = '';
              }}
              data-testid="collaborators-file-input"
            />
            <Button
              type="button"
              variant="outline"
              loading={isReadingFile}
              onClick={() => fileInputRef.current?.click()}
            >
              {!isReadingFile && <UploadIcon className="mr-2 h-4 w-4" aria-hidden />}
              {fileName ? <Trans>Escolher outro arquivo</Trans> : <Trans>Escolher arquivo</Trans>}
            </Button>
          </div>
        </TabsContent>
      </Tabs>

      <div aria-live="polite" className="min-h-6">
        {isChecking && (
          <p className="flex items-center gap-2 text-muted-foreground text-sm" data-testid="collaborators-checking">
            <Loader2Icon className="h-4 w-4 animate-spin" aria-hidden />
            <Trans>Conferindo a lista na base do RH…</Trans>
          </p>
        )}

        {!isChecking && shownError && (
          <p className="text-destructive text-sm" role="alert" data-testid="collaborators-error">
            {shownError}
          </p>
        )}
      </div>

      {preview && (
        <PreviewTable
          preview={preview}
          isStale={isChecking}
          source={previewOrigin === 'file' && fileName ? t`Arquivo ${fileName}` : t`Lista colada`}
        />
      )}
    </div>
  );
};

const PreviewTable = ({ preview, isStale, source }: { preview: PreviewResult; isStale: boolean; source: string }) => {
  const { t } = useLingui();

  const [onlyErrors, setOnlyErrors] = useState(false);
  const checkboxId = useId();

  const errorRows = preview.rows.filter((row) => row.issues.length > 0);
  const rows = onlyErrors ? errorRows : preview.rows;

  const ready = formatCount(preview.ready);
  const withErrors = formatCount(preview.withErrors);
  const duplicates = formatCount(preview.duplicates);

  const downloadErrors = () => {
    const lines = [
      ['linha', 'nome', 'email', 'CPF', 'erro'].join(';'),
      ...errorRows.map((row) =>
        [String(row.line), row.name, row.email, row.cpf ? maskCpf(row.cpf) : '', row.issues.join(', ')]
          .map(escapeCsvCell)
          .join(';'),
      ),
    ];

    downloadText(`\uFEFF${lines.join('\r\n')}\r\n`, 'linhas-com-erro.csv');
  };

  return (
    <div className={cn('flex flex-col gap-3', isStale && 'opacity-60')} data-testid="collaborators-preview">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-muted-foreground text-xs">{source}</p>
          <p className="font-display font-extrabold text-[17px]" data-testid="collaborators-summary">
            {t`${ready} prontos · ${withErrors} com erro · ${duplicates} repetidos`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {errorRows.length > 0 && (
            <div className="flex items-center gap-2">
              <Checkbox
                id={checkboxId}
                checked={onlyErrors}
                onCheckedChange={(value) => setOnlyErrors(value === true)}
              />
              <Label htmlFor={checkboxId} className="font-normal text-sm">
                <Trans>Só as linhas com erro</Trans>
              </Label>
            </div>
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={errorRows.length === 0}
            onClick={downloadErrors}
            data-testid="collaborators-download-errors"
          >
            <DownloadIcon className="mr-2 h-4 w-4" aria-hidden />
            <Trans>Baixar as linhas com erro</Trans>
          </Button>
        </div>
      </div>

      <p className="text-muted-foreground text-sm">
        <Trans>
          Só as linhas prontas recebem o contrato, com o nome que está no RH. Para incluir as outras, corrija a planilha
          e cole de novo.
        </Trans>
      </p>

      <div className="max-h-[460px] overflow-auto rounded-xl ring-1 ring-border">
        <table className="w-full min-w-[720px] border-collapse text-left text-sm">
          <thead className="sticky top-0 z-10 bg-card shadow-[0_1px_0_hsl(var(--border))]">
            <tr className="text-muted-foreground">
              <th scope="col" className="px-3 py-2 font-semibold">
                <Trans>Linha</Trans>
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                <Trans>Nome na lista</Trans>
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                <Trans>Nome no RH</Trans>
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                <Trans>E-mail</Trans>
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                CPF
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                <Trans>Situação</Trans>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isReady = row.issues.length === 0;

              return (
                <tr
                  key={row.line}
                  className={cn('border-border border-t align-top', isReady ? 'bg-success-bg/50' : 'bg-danger-bg/70')}
                  data-testid={isReady ? 'preview-row-ready' : 'preview-row-error'}
                >
                  <td className="px-3 py-2 text-muted-foreground tabular-nums">{row.line}</td>
                  <td className="px-3 py-2">{row.name || '—'}</td>
                  <td className="px-3 py-2 font-semibold">{row.hrName ?? '—'}</td>
                  <td className="break-all px-3 py-2">{row.email || '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">{row.cpf ? maskCpf(row.cpf) : '—'}</td>
                  <td className="px-3 py-2">
                    {isReady ? (
                      <span className="inline-flex items-center gap-1 font-semibold text-success">
                        <CheckIcon className="h-4 w-4" aria-hidden />
                        <Trans>Pronto</Trans>
                      </span>
                    ) : (
                      <span className="inline-flex items-start gap-1 font-semibold text-destructive">
                        <XIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                        {row.issues.join('; ')}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
