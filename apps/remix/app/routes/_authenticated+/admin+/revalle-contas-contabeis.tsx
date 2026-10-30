import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import { Checkbox } from '@documenso/ui/primitives/checkbox';
import { Input } from '@documenso/ui/primitives/input';
import { Label } from '@documenso/ui/primitives/label';
import { Textarea } from '@documenso/ui/primitives/textarea';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { Trans, useLingui } from '@lingui/react/macro';
import { CalculatorIcon } from 'lucide-react';
import { DateTime } from 'luxon';
import { type ChangeEvent, useEffect, useState } from 'react';

const TIMEZONE = 'America/Bahia';

const formatDate = (date: Date) => DateTime.fromJSDate(new Date(date)).setZone(TIMEZONE).toFormat('dd/MM/yyyy HH:mm');

type CsvInput = { csv: string } | { csvBase64: string; fileName: string };

type Preview = {
  accounts: { code: string }[];
  errors: { line: number; message: string }[];
  encoding: 'utf-8' | 'windows-1252';
};

// O arquivo vai em base64 e é decodificado no servidor (UTF-8, senão Windows-1252 do Excel), igual para tela e teste.
const readFileAsBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

const AiStatusSection = () => {
  const { data } = trpc.revalle.invoice.adminGetSettings.useQuery();

  if (!data) {
    return null;
  }

  const model = data.model;

  return (
    <div className="mt-6 rounded-md border p-4 text-sm">
      {data.aiStatus === 'CONFIGURED' && (
        <p>
          <Trans>Sugestão por IA: Gemini configurado (modelo {model}).</Trans>
        </p>
      )}
      {data.aiStatus === 'NO_KEY' && (
        <p>
          <Trans>Sugestão por IA: sem chave do Gemini. A escolha da conta funciona, mas sem sugestão.</Trans>
        </p>
      )}
      {data.aiStatus === 'DISABLED' && (
        <p>
          <Trans>Sugestão por IA: desligada. A escolha da conta funciona, mas sem sugestão.</Trans>
        </p>
      )}
    </div>
  );
};

const ImportSection = ({ onApplied }: { onApplied: () => void }) => {
  const { t } = useLingui();
  const { toast } = useToast();

  const [text, setText] = useState('');
  const [input, setInput] = useState<CsvInput | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [fileKey, setFileKey] = useState(0);

  const { mutateAsync: previewAccounts, isPending: isPreviewing } =
    trpc.revalle.invoice.adminPreviewAccounts.useMutation();
  const { mutateAsync: importAccounts, isPending: isImporting } =
    trpc.revalle.invoice.adminImportAccounts.useMutation();

  const reset = () => {
    setText('');
    setInput(null);
    setPreview(null);
    setFileKey((key) => key + 1);
  };

  const runPreview = async (next: CsvInput) => {
    setInput(next);
    setPreview(null);

    try {
      const csv = 'csv' in next ? { csv: next.csv } : { csvBase64: next.csvBase64 };

      setPreview(await previewAccounts(csv));
    } catch {
      toast({ title: t`Não foi possível ler a lista.`, variant: 'destructive' });
    }
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    if (file.size > 1_000_000) {
      toast({ title: t`O arquivo passa de 1 MB.`, variant: 'destructive' });
      return;
    }

    setText('');

    try {
      await runPreview({ csvBase64: await readFileAsBase64(file), fileName: file.name });
    } catch {
      toast({ title: t`Não foi possível ler a lista.`, variant: 'destructive' });
    }
  };

  const onApply = async () => {
    if (!input) {
      return;
    }

    try {
      const csv = 'csv' in input ? { csv: input.csv } : { csvBase64: input.csvBase64 };
      const { created, updated, deactivated } = await importAccounts(csv);

      toast({ title: t`Lista aplicada: ${created} novas, ${updated} alteradas, ${deactivated} desativadas.` });
      reset();
      onApplied();
    } catch {
      toast({ title: t`Não foi possível aplicar a lista.`, variant: 'destructive' });
    }
  };

  const fileName = input && 'fileName' in input ? input.fileName : null;
  const canApply = preview !== null && preview.errors.length === 0 && preview.accounts.length > 0;
  const validCount = preview?.accounts.length ?? 0;

  return (
    <section className="mt-8">
      <h3 className="font-semibold text-xl">
        <Trans>Importar lista de contas</Trans>
      </h3>
      <p className="mt-1 text-muted-foreground text-sm">
        <Trans>
          Arquivo CSV separado por ponto e vírgula, com as colunas numero;nome;descricao;tipo. O tipo é pagar, receber
          ou vazio.
        </Trans>
      </p>
      <p className="mt-1 text-muted-foreground text-sm">
        <Trans>
          A lista nova substitui a atual. Contas que saírem ficam inativas: documentos antigos continuam com elas, mas
          elas não aparecem em documentos novos.
        </Trans>
      </p>

      <div className="mt-4 space-y-2">
        <Label htmlFor="revalle-accounts-file">
          <Trans>Enviar arquivo CSV</Trans>
        </Label>
        <Input
          key={fileKey}
          id="revalle-accounts-file"
          type="file"
          accept=".csv,text/csv"
          className="max-w-sm"
          disabled={isPreviewing || isImporting}
          onChange={(event) => void onFile(event)}
        />
      </div>

      <div className="mt-4 space-y-2">
        <Label htmlFor="revalle-accounts-text">
          <Trans>Ou cole a lista aqui</Trans>
        </Label>
        <Textarea
          id="revalle-accounts-text"
          className="min-h-[8rem] font-mono text-xs"
          placeholder="numero;nome;descricao;tipo"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setInput(null);
            setPreview(null);
          }}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={text.trim() === '' || isPreviewing || isImporting}
          onClick={() => void runPreview({ csv: text })}
        >
          <Trans>Ver prévia</Trans>
        </Button>
      </div>

      {preview && (
        <div className="mt-4 rounded-md border p-4 text-sm">
          {fileName && (
            <p className="text-muted-foreground">
              <Trans>Arquivo: {fileName}</Trans>
            </p>
          )}
          {preview.encoding === 'windows-1252' && (
            <p className="text-muted-foreground">
              <Trans>O arquivo não estava em UTF-8; foi lido como Windows-1252 (padrão do Excel).</Trans>
            </p>
          )}
          <p className="font-medium">
            <Trans>Contas válidas: {validCount}</Trans>
          </p>

          {preview.errors.length > 0 && (
            <>
              <p className="mt-2 font-medium text-destructive">
                <Trans>Corrija estes erros e envie de novo. Nada foi gravado.</Trans>
              </p>
              <ul className="mt-1 list-disc pl-5 text-destructive">
                {preview.errors.map(({ line, message }) => (
                  <li key={`${line}-${message}`}>
                    <Trans>
                      Linha {line}: {message}
                    </Trans>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="mt-4 flex gap-2">
            <Button size="sm" disabled={!canApply || isImporting} onClick={() => void onApply()}>
              <Trans>Aplicar</Trans>
            </Button>
            <Button size="sm" variant="ghost" disabled={isImporting} onClick={reset}>
              <Trans>Cancelar</Trans>
            </Button>
          </div>
        </div>
      )}
    </section>
  );
};

const AccountsSection = ({ refreshKey }: { refreshKey: number }) => {
  const { t } = useLingui();

  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(searchInput.trim()), 400);

    return () => clearTimeout(timer);
  }, [searchInput]);

  const { data, isPending, refetch } = trpc.revalle.invoice.adminFindAccounts.useQuery({
    query: query || undefined,
    includeInactive,
  });

  useEffect(() => {
    if (refreshKey > 0) {
      void refetch();
    }
  }, [refreshKey, refetch]);

  const kindLabel = (kind: 'PAYABLE' | 'RECEIVABLE' | null) => {
    if (kind === 'PAYABLE') {
      return t`A pagar`;
    }

    if (kind === 'RECEIVABLE') {
      return t`A receber`;
    }

    return '-';
  };

  const shown = data?.accounts.length ?? 0;
  const total = data?.total ?? 0;

  return (
    <section className="mt-12">
      <h3 className="font-semibold text-xl">
        <Trans>Contas</Trans>
      </h3>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <Input
          className="max-w-sm"
          placeholder={t`Buscar por número ou nome`}
          aria-label={t`Buscar por número ou nome`}
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
        <div className="flex items-center gap-2">
          <Checkbox
            id="revalle-accounts-inactive"
            checked={includeInactive}
            onCheckedChange={(checked) => setIncludeInactive(checked === true)}
          />
          <Label htmlFor="revalle-accounts-inactive">
            <Trans>Mostrar inativas</Trans>
          </Label>
        </div>
      </div>

      <div className="mt-4 overflow-x-auto rounded-md border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="p-3">
                <Trans>Número</Trans>
              </th>
              <th className="p-3">
                <Trans>Nome</Trans>
              </th>
              <th className="p-3">
                <Trans>Descrição</Trans>
              </th>
              <th className="p-3">
                <Trans>Tipo</Trans>
              </th>
              {includeInactive && (
                <th className="p-3">
                  <Trans>Situação</Trans>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {data?.accounts.map((account) => (
              <tr key={account.code} className={account.active ? 'border-t' : 'border-t text-muted-foreground'}>
                <td className="whitespace-nowrap p-3">{account.code}</td>
                <td className="p-3">{account.name}</td>
                <td className="max-w-[20rem] p-3">{account.description || '-'}</td>
                <td className="whitespace-nowrap p-3">{kindLabel(account.kind)}</td>
                {includeInactive && <td className="whitespace-nowrap p-3">{account.active ? t`Ativa` : t`Inativa`}</td>}
              </tr>
            ))}
            {!isPending && shown === 0 && (
              <tr>
                <td colSpan={includeInactive ? 5 : 4} className="p-4 text-center text-muted-foreground">
                  <Trans>Nenhuma conta encontrada.</Trans>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {shown < total && (
        <p className="mt-2 text-muted-foreground text-sm">
          <Trans>
            Mostrando {shown} de {total}. Use a busca para achar as outras.
          </Trans>
        </p>
      )}
    </section>
  );
};

const SettingsSection = () => {
  const { t } = useLingui();
  const { toast } = useToast();

  const { data, refetch } = trpc.revalle.invoice.adminGetSettings.useQuery();
  const { mutateAsync: updateSettings, isPending } = trpc.revalle.invoice.adminUpdateSettings.useMutation();

  const [prompt, setPrompt] = useState('');
  const [accountingEmail, setAccountingEmail] = useState('');

  useEffect(() => {
    if (data) {
      setPrompt(data.prompt);
      setAccountingEmail(data.accountingEmail ?? '');
    }
  }, [data]);

  const onSave = async () => {
    try {
      await updateSettings({ prompt, accountingEmail: accountingEmail.trim() });
      toast({ title: t`Configurações salvas.` });
      void refetch();
    } catch {
      toast({ title: t`Não foi possível salvar. Confira o e-mail da contabilidade.`, variant: 'destructive' });
    }
  };

  const updatedByName = data?.updatedBy ? (data.updatedBy.name ?? data.updatedBy.email) : null;
  const updatedAt = data?.updatedAt ? formatDate(data.updatedAt) : null;

  return (
    <section className="mt-12">
      <h3 className="font-semibold text-xl">
        <Trans>Sugestão e contabilidade</Trans>
      </h3>

      <fieldset className="mt-4 space-y-4" disabled={!data || isPending}>
        <div className="space-y-2">
          <Label htmlFor="revalle-accounts-prompt">
            <Trans>Prompt</Trans>
          </Label>
          <p className="text-muted-foreground text-sm">
            <Trans>
              Orientações para a IA escolher a conta (ex.: regras da empresa). A lista de contas ativas é enviada junto,
              sempre.
            </Trans>
          </p>
          <Textarea
            id="revalle-accounts-prompt"
            className="min-h-[8rem]"
            maxLength={10_000}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="revalle-accounting-email">
            <Trans>E-mail da contabilidade</Trans>
          </Label>
          <p className="text-muted-foreground text-sm">
            <Trans>Recebe o PDF assinado das notas fiscais. Pode ficar vazio.</Trans>
          </p>
          <Input
            id="revalle-accounting-email"
            type="email"
            className="max-w-sm"
            value={accountingEmail}
            onChange={(event) => setAccountingEmail(event.target.value)}
          />
        </div>

        <Button onClick={() => void onSave()}>
          <Trans>Salvar</Trans>
        </Button>

        {updatedByName && updatedAt && (
          <p className="text-muted-foreground text-sm">
            <Trans>
              Alterado por {updatedByName} em {updatedAt}.
            </Trans>
          </p>
        )}
      </fieldset>
    </section>
  );
};

export default function AdminRevalleContasContabeisPage() {
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div>
      <div className="flex items-center gap-3">
        <CalculatorIcon className="h-8 w-8" />
        <h2 className="font-semibold text-4xl">
          <Trans>Contas contábeis</Trans>
        </h2>
      </div>

      <AiStatusSection />
      <ImportSection onApplied={() => setRefreshKey((key) => key + 1)} />
      <AccountsSection refreshKey={refreshKey} />
      <SettingsSection />
    </div>
  );
}
