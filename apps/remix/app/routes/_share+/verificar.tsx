// REVALLE: página pública de verificação de documento assinado (Fase 4).

import { formatRevalleDateTime } from '@documenso/lib/revalle/date-format';
import { createRateLimit } from '@documenso/lib/server-only/rate-limit/rate-limit';
import {
  findRevalleProofByCode,
  normalizeVerificationCodeInput,
} from '@documenso/lib/server-only/revalle/proof/find-proof-by-code';
import { getIpAddress } from '@documenso/lib/universal/get-ip-address';
import { Button } from '@documenso/ui/primitives/button';
import { Input } from '@documenso/ui/primitives/input';
import { useState } from 'react';
import { data, Form, useLoaderData } from 'react-router';

import type { Route } from './+types/verificar';

const verifyRateLimit = createRateLimit({ action: 'revalle.verify', max: 30, window: '15m' });

const MAX_FILE_BYTES = 50 * 1024 * 1024;

export function meta() {
  return [{ title: 'Verificar documento · RevSign' }, { name: 'robots', content: 'noindex' }];
}

type LoaderData =
  | { state: 'idle' }
  | { state: 'not-found'; codigo: string }
  | { state: 'limited' }
  | {
      state: 'found';
      codigo: string;
      documentTitle: string;
      completed: boolean;
      completedAtLabel: string | null;
      items: { title: string; finalSha256: string | null }[];
      signers: { nome: string; cpfMasked: string | null; signedAtLabel: string }[];
    };

export const loader = async ({ request }: Route.LoaderArgs) => {
  const raw = new URL(request.url).searchParams.get('codigo');

  if (raw === null || raw.trim() === '') {
    return data<LoaderData>({ state: 'idle' });
  }

  // Formato e alfabeto antes de qualquer consulta ao banco.
  const codigo = normalizeVerificationCodeInput(raw.slice(0, 64));

  if (!codigo) {
    return data<LoaderData>({ state: 'not-found', codigo: '' });
  }

  let ip = 'unknown';

  try {
    ip = getIpAddress(request);
  } catch {
    // sem IP: conta no mesmo balde
  }

  const limit = await verifyRateLimit.check({ ip });

  if (limit.isLimited) {
    return data<LoaderData>(
      { state: 'limited' },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.max(1, Math.ceil((limit.reset.getTime() - Date.now()) / 1000))) },
      },
    );
  }

  const result = await findRevalleProofByCode(codigo);

  if (!result) {
    return data<LoaderData>({ state: 'not-found', codigo });
  }

  return data<LoaderData>({
    state: 'found',
    codigo,
    documentTitle: result.documentTitle,
    completed: result.status === 'COMPLETED',
    completedAtLabel: result.completedAt ? formatRevalleDateTime(result.completedAt) : null,
    items: result.items,
    signers: result.signers.map((s) => ({
      nome: s.nome,
      cpfMasked: s.cpfMasked,
      signedAtLabel: formatRevalleDateTime(s.signedAt),
    })),
  });
};

const toHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');

type FileCheck =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; match: boolean };

const FileChecker = ({ hashes }: { hashes: string[] }) => {
  const [check, setCheck] = useState<FileCheck>({ kind: 'idle' });

  const onChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (!file) {
      setCheck({ kind: 'idle' });
      return;
    }

    if (file.size > MAX_FILE_BYTES) {
      setCheck({ kind: 'error', message: 'O arquivo é maior que 50 MB. Escolha o PDF assinado.' });
      return;
    }

    setCheck({ kind: 'working' });

    try {
      // O arquivo nunca sai do aparelho: o hash é calculado aqui, no navegador.
      const digest = toHex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));

      setCheck({ kind: 'done', match: hashes.includes(digest) });
    } catch {
      setCheck({ kind: 'error', message: 'Não foi possível ler este arquivo neste navegador.' });
    }
  };

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <h2 className="font-semibold text-xl">Conferir um arquivo</h2>
      <p className="text-muted-foreground text-sm">
        Escolha o PDF que você recebeu para saber se ele é exatamente o documento assinado. O arquivo não sai do seu
        aparelho: a conferência é feita aqui, no navegador.
      </p>
      <input
        accept="application/pdf,.pdf"
        className="block w-full text-sm"
        data-testid="verify-file"
        onChange={(e) => void onChange(e)}
        type="file"
      />
      <div aria-live="polite" role="status">
        {check.kind === 'working' && <p className="text-sm">Conferindo…</p>}
        {check.kind === 'error' && <p className="text-destructive text-sm">{check.message}</p>}
        {check.kind === 'done' && check.match && (
          <p className="font-medium text-green-700 dark:text-green-400">
            Este arquivo é exatamente o documento assinado.
          </p>
        )}
        {check.kind === 'done' && !check.match && (
          <p className="font-medium text-destructive">Este arquivo é diferente do documento assinado.</p>
        )}
      </div>
    </section>
  );
};

export default function VerificarPage() {
  const result = useLoaderData<typeof loader>() as LoaderData;
  const initial = result.state === 'found' || result.state === 'not-found' ? result.codigo : '';
  const hashes = result.state === 'found' ? result.items.flatMap((i) => (i.finalSha256 ? [i.finalSha256] : [])) : [];

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 text-foreground">
      <header className="space-y-2">
        <h1 className="font-semibold text-3xl">Verificar documento</h1>
        <p className="text-muted-foreground text-sm">
          Digite o código de verificação que aparece no carimbo da assinatura (formato XXXX-XXXX).
        </p>
      </header>

      <Form className="flex flex-col gap-2 sm:flex-row" method="get">
        <label className="sr-only" htmlFor="codigo">
          Código de verificação
        </label>
        <Input
          autoCapitalize="characters"
          autoComplete="off"
          defaultValue={initial}
          id="codigo"
          maxLength={16}
          name="codigo"
          placeholder="Código de verificação"
          required
        />
        <Button type="submit">Verificar</Button>
      </Form>

      {result.state === 'limited' && (
        <p className="text-destructive">Muitas consultas. Tente novamente em alguns minutos.</p>
      )}

      {result.state === 'not-found' && <p className="text-destructive">Código não encontrado.</p>}

      {result.state === 'found' && (
        <>
          <section className="space-y-4 rounded-lg border p-4">
            <div>
              <p className="text-muted-foreground text-sm">Documento</p>
              <h2 className="break-words font-semibold text-xl">{result.documentTitle}</h2>
            </div>

            <p className="font-medium">
              {result.completed
                ? `Concluído em ${result.completedAtLabel ?? ''} (horário de Brasília)`
                : 'Em andamento'}
            </p>

            <div>
              <h3 className="mb-2 font-medium">Assinaturas</h3>
              <ul className="space-y-2">
                {result.signers.map((s, index) => (
                  <li className="rounded-md bg-muted/40 p-3 text-sm" key={`${s.nome}-${index}`}>
                    <p className="font-medium">{s.nome}</p>
                    <p>CPF {s.cpfMasked ?? 'não verificado'}</p>
                    <p>Assinou em {s.signedAtLabel} (horário de Brasília)</p>
                  </li>
                ))}
              </ul>
            </div>

            {result.completed && (
              <div className="space-y-2">
                <h3 className="font-medium">SHA-256 do documento final</h3>
                {result.items.map((item, index) => (
                  <div key={`${item.title}-${index}`}>
                    {result.items.length > 1 && <p className="break-words text-sm">{item.title}</p>}
                    <code className="block break-all rounded bg-muted p-2 text-xs">
                      {item.finalSha256 ?? 'Selagem em andamento'}
                    </code>
                  </div>
                ))}
              </div>
            )}
          </section>

          {hashes.length > 0 && <FileChecker hashes={hashes} />}
        </>
      )}
    </div>
  );
}
