// REVALLE: página pública de verificação de documento assinado (Fase 4).

import { formatRevalleProofFactors, formatRevalleProofTerm } from '@documenso/lib/revalle/certificate-rows';
import { formatRevalleDateTime } from '@documenso/lib/revalle/date-format';
import { costCenterLabel } from '@documenso/lib/revalle/invoice/cost-centers';
import { revalleRoleVerb } from '@documenso/lib/revalle/role-verbs';
import {
  findSealedVersionMatch,
  type RevalleSealedMatch,
  type RevalleSealedVersion,
} from '@documenso/lib/revalle/sealed-versions';
import { createRateLimit } from '@documenso/lib/server-only/rate-limit/rate-limit';
import {
  findRevalleProofByCode,
  normalizeVerificationCodeInput,
} from '@documenso/lib/server-only/revalle/proof/find-proof-by-code';
import { revalleRateLimitIpKey } from '@documenso/lib/server-only/revalle/rate-limit-ip-key';
import { getIpAddress } from '@documenso/lib/universal/get-ip-address';
import { Button } from '@documenso/ui/primitives/button';
import { Input } from '@documenso/ui/primitives/input';
import { CheckIcon, CopyIcon, ShieldCheckIcon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { data, Form, useLoaderData } from 'react-router';
import { BrandBand } from '~/components/general/background';
import { RevsignWordmark } from '~/components/revalle/shell/revsign-wordmark';

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
      status: 'COMPLETED' | 'REJECTED' | 'PENDING';
      completedAtLabel: string | null;
      /** `versions`: todas as selagens do arquivo, da mais antiga para a atual (a última é `finalSha256`). */
      items: { title: string; finalSha256: string | null; versions: RevalleSealedVersion[] }[];
      signers: {
        nome: string;
        cpfMasked: string | null;
        showCpf: boolean;
        signedAtLabel: string;
        verb: string;
        factorsLabel: string;
        termLabel: string;
      }[];
      /** Fase 6, NF que passou pelo Financeiro: conta, aprovação e substituição (nada da nova versão). */
      invoice: {
        accountLabel: string | null;
        approvalLabel: string | null;
        isAwaitingApproval: boolean;
        supersededLabel: string | null;
      } | null;
      /** Fase 7, NF com centro de custo (com ou sem passagem pelo Financeiro): "Centro de custo: 101 – Puxada". */
      costCenterLabel: string | null;
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

  // Sem IP legível, todos caem no mesmo balde 'unknown' (e dividem o limite). IPv6 conta por /64.
  let ip = 'unknown';

  try {
    ip = revalleRateLimitIpKey(getIpAddress(request));
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
    status: result.status,
    completedAtLabel: result.completedAt ? formatRevalleDateTime(result.completedAt) : null,
    items: result.items.map((item) => ({
      title: item.title,
      finalSha256: item.finalSha256,
      versions: item.sealedVersions.map((version) => ({
        sha256: version.sha256,
        sealedAtLabel: formatRevalleDateTime(version.sealedAt),
      })),
    })),
    signers: result.signers.map((s) => ({
      nome: s.nome,
      cpfMasked: s.cpfMasked,
      // Leitor (VIEWER/CC) não passa pelo portão: nunca informa CPF, então "não verificado" sugeriria uma falha.
      showCpf: s.role !== 'VIEWER' && s.role !== 'CC',
      signedAtLabel: formatRevalleDateTime(s.signedAt),
      verb: revalleRoleVerb(s.role),
      factorsLabel: formatRevalleProofFactors(s.factors),
      termLabel: formatRevalleProofTerm(s.termVersion, s.termAcceptedAt),
    })),
    invoice: result.invoice && {
      accountLabel: result.invoice.account
        ? `Conta contábil: ${result.invoice.account.code}${result.invoice.account.name ? ` – ${result.invoice.account.name}` : ''}`
        : null,
      approvalLabel: result.invoice.approval
        ? `Aprovada pelo Financeiro${result.invoice.approval.approverName ? ` (${result.invoice.approval.approverName})` : ''} em ${formatRevalleDateTime(result.invoice.approval.approvedAt, { withZoneLabel: true })}`
        : null,
      isAwaitingApproval: result.invoice.isAwaitingApproval,
      supersededLabel: result.invoice.supersededAt
        ? `Substituído por uma nova versão em ${formatRevalleDateTime(result.invoice.supersededAt)} (${result.invoice.supersedeKind === 'COST_CENTER' ? 'centro de custo corrigido' : 'conta contábil alterada'})`
        : null,
    },
    costCenterLabel: result.costCenter ? `Centro de custo: ${costCenterLabel(result.costCenter.code)}` : null,
  });
};

const toHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');

type FileCheck =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; match: RevalleSealedMatch | null };

const FileChecker = ({ items }: { items: { versions: RevalleSealedVersion[] }[] }) => {
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

      // Confere com QUALQUER versão selada: uma cópia de antes de uma reselagem continua sendo o documento assinado.
      setCheck({ kind: 'done', match: findSealedVersionMatch(digest, items) });
    } catch {
      setCheck({ kind: 'error', message: 'Não foi possível ler este arquivo neste navegador.' });
    }
  };

  return (
    <section className="space-y-3 rounded-card bg-card p-5 shadow-card sm:p-6">
      <h2 className="text-xl">Conferir um arquivo</h2>
      <p className="text-muted-foreground text-sm">
        Escolha o PDF que você recebeu para saber se ele é exatamente o documento assinado. O arquivo não sai do seu
        aparelho: a conferência é feita aqui, no navegador.
      </p>
      <input
        accept="application/pdf,.pdf"
        className="block w-full rounded-[13px] border border-input bg-background p-2 text-sm file:mr-3 file:rounded-full file:border-0 file:bg-accent file:px-4 file:py-2 file:font-semibold file:text-accent-foreground"
        data-testid="verify-file"
        onChange={(e) => void onChange(e)}
        type="file"
      />
      <div aria-live="polite" role="status">
        {check.kind === 'working' && <p className="text-sm">Conferindo…</p>}
        {check.kind === 'error' && <p className="text-destructive text-sm">{check.message}</p>}
        {check.kind === 'done' && check.match && (
          <>
            <p className="font-medium text-success">
              Este arquivo confere com a versão selada em {check.match.sealedAtLabel} (horário de Brasília).
            </p>
            {check.match.newerSealedAtLabel && (
              <p className="text-muted-foreground text-sm">
                Existe uma versão selada mais recente deste documento, de {check.match.newerSealedAtLabel} (horário de
                Brasília).
              </p>
            )}
          </>
        )}
        {check.kind === 'done' && !check.match && (
          <p className="font-medium text-destructive">Este arquivo é diferente do documento assinado.</p>
        )}
      </div>
    </section>
  );
};

const CopyLinkButton = ({ codigo }: { codigo: string }) => {
  const [isCopied, setIsCopied] = useState(false);

  const onCopy = async () => {
    const url = `${window.location.origin}/verificar?codigo=${encodeURIComponent(codigo)}`;

    try {
      await navigator.clipboard.writeText(url);
      setIsCopied(true);
      window.setTimeout(() => setIsCopied(false), 2000);
    } catch {
      window.prompt('Copie o link desta verificação:', url);
    }
  };

  return (
    <Button className="w-full sm:w-auto" onClick={() => void onCopy()} type="button" variant="outline">
      {isCopied ? <CheckIcon className="mr-2 h-4 w-4" /> : <CopyIcon className="mr-2 h-4 w-4" />}
      {isCopied ? 'Link copiado' : 'Copiar link desta verificação'}
    </Button>
  );
};

export default function VerificarPage() {
  const result = useLoaderData<typeof loader>() as LoaderData;
  const initial = result.state === 'found' || result.state === 'not-found' ? result.codigo : '';
  const hasSealedVersions = result.state === 'found' && result.items.some((item) => item.versions.length > 0);
  const isAuthentic = result.state === 'found' && result.status === 'COMPLETED' && !result.invoice?.supersededLabel;

  // REVALLE: redesign v3. Faixa azul em largura total (anula o padding do layout de _share), cartões por bloco.
  return (
    <div className="-mx-4 -my-12 min-h-screen text-foreground md:-mx-12 md:-my-12 lg:-mx-24 lg:-my-24">
      <BrandBand className="rounded-b-[26px] lg:pb-16">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
          <RevsignWordmark variant="onBrand" size="lg" />
          <h1 className="text-[30px] text-white leading-tight">Verificar documento</h1>
        </div>
      </BrandBand>

      <div className="mx-auto -mt-8 w-full max-w-2xl space-y-4 px-4 pb-12 sm:px-0">
        <section className="rounded-card bg-card p-5 shadow-card sm:p-6">
          <Form className="flex flex-col gap-4" method="get">
            <label className="font-semibold text-sm" htmlFor="codigo">
              Código do documento
            </label>
            <Input
              autoCapitalize="characters"
              autoComplete="off"
              className="h-14 text-center font-semibold text-xl uppercase tracking-[0.2em]"
              defaultValue={initial}
              id="codigo"
              maxLength={16}
              name="codigo"
              placeholder="XXXX-XXXX"
              required
            />
            <p className="text-muted-foreground text-sm">
              Digite o código de verificação que aparece no carimbo da assinatura (formato XXXX-XXXX).
            </p>
            <Button className="w-full" size="lg" type="submit">
              Verificar
            </Button>
          </Form>
        </section>

        {result.state === 'limited' && (
          <section className="flex gap-3 rounded-card bg-warning-bg p-5 text-warning-text shadow-card" role="alert">
            <TriangleAlertIcon aria-hidden className="mt-0.5 h-6 w-6 flex-shrink-0" />
            <p className="font-medium">Muitas consultas. Tente novamente em alguns minutos.</p>
          </section>
        )}

        {result.state === 'not-found' && (
          <section className="flex gap-3 rounded-card bg-warning-bg p-5 text-warning-text shadow-card" role="alert">
            <TriangleAlertIcon aria-hidden className="mt-0.5 h-6 w-6 flex-shrink-0" />
            <p className="font-medium">Código não encontrado.</p>
          </section>
        )}

        {result.state === 'found' && (
          <>
            <section
              className={`flex gap-3 rounded-card p-5 shadow-card sm:p-6 ${isAuthentic ? 'bg-success-bg' : 'bg-card'}`}
              data-testid="verify-authentic"
            >
              <ShieldCheckIcon
                aria-hidden
                className={`mt-0.5 h-7 w-7 flex-shrink-0 ${isAuthentic ? 'text-success' : 'text-muted-foreground'}`}
              />
              <div className="space-y-1 text-sm">
                <p className={`font-semibold text-base ${isAuthentic ? 'text-success' : ''}`}>
                  Código {result.codigo} encontrado no RevSign
                </p>
                <p className="text-foreground/80">
                  Este documento foi assinado eletronicamente no RevSign, o sistema de assinaturas da Revalle. Cada
                  participante foi identificado, aceitou o termo de assinatura eletrônica e confirmou a assinatura com
                  um código enviado ao seu e-mail. A integridade do arquivo é garantida pelo SHA-256 abaixo (MP
                  2.200-2/2001, art. 10, § 2º).
                </p>
              </div>
            </section>

            <section className="space-y-4 rounded-card bg-card p-5 shadow-card sm:p-6">
              <div>
                <p className="text-muted-foreground text-sm">Documento</p>
                <h2 className="break-words text-xl">{result.documentTitle}</h2>
              </div>

              <p className="font-medium">
                {result.status === 'COMPLETED' && `Concluído em ${result.completedAtLabel ?? ''} (horário de Brasília)`}
                {result.status === 'REJECTED' && `Recusado em ${result.completedAtLabel ?? ''} (horário de Brasília)`}
                {result.status === 'PENDING' && !result.invoice?.supersededLabel && 'Em andamento'}
              </p>

              {result.invoice?.supersededLabel && (
                <p className="rounded-[13px] bg-warning-bg p-3 font-medium text-warning-text">
                  {result.invoice.supersededLabel}
                </p>
              )}

              {(result.invoice?.accountLabel || result.invoice?.isAwaitingApproval || result.costCenterLabel) && (
                <div className="space-y-1 text-sm" data-testid="verify-invoice">
                  <h3 className="font-semibold text-base">Nota fiscal</h3>
                  {result.invoice?.accountLabel && <p className="break-words">{result.invoice.accountLabel}</p>}
                  {result.invoice?.approvalLabel && <p>{result.invoice.approvalLabel}</p>}
                  {result.costCenterLabel && <p className="break-words">{result.costCenterLabel}</p>}
                  {result.invoice?.isAwaitingApproval && (
                    <p className="text-muted-foreground">Aguardando aprovação do Financeiro</p>
                  )}
                </div>
              )}
            </section>

            <section className="rounded-card bg-card p-5 shadow-card sm:p-6">
              <h3 className="mb-3 font-semibold">Participantes</h3>
              <ul className="space-y-2">
                {result.signers.map((s, index) => (
                  <li className="rounded-[13px] bg-muted/60 p-4 text-sm" key={`${s.nome}-${index}`}>
                    <p className="font-semibold text-base">{s.nome}</p>
                    {s.showCpf && <p>CPF {s.cpfMasked ?? 'não verificado'}</p>}
                    <p>
                      {s.verb} {s.signedAtLabel} (horário de Brasília)
                    </p>
                    {s.factorsLabel !== '—' && <p className="text-muted-foreground">Identificação: {s.factorsLabel}</p>}
                    {s.termLabel !== '—' && (
                      <p className="text-muted-foreground">Termo de assinatura eletrônica: {s.termLabel}</p>
                    )}
                  </li>
                ))}
              </ul>
            </section>

            {result.status === 'COMPLETED' && (
              <section className="space-y-2 rounded-card bg-card p-5 shadow-card sm:p-6">
                <h3 className="font-semibold">SHA-256 do documento final</h3>
                {result.items.map((item, index) => (
                  <div key={`${item.title}-${index}`}>
                    {result.items.length > 1 && <p className="break-words text-sm">{item.title}</p>}
                    <code className="block break-all rounded-[13px] bg-muted p-3 text-xs">
                      {item.finalSha256 ?? 'Selagem em andamento'}
                    </code>
                    {item.versions.length > 1 && (
                      <div className="mt-2 space-y-1 text-muted-foreground text-xs">
                        <p>Versões seladas anteriores (substituídas por uma reselagem):</p>
                        {item.versions.slice(0, -1).map((version, versionIndex) => (
                          <p className="break-all" key={`${version.sha256}-${versionIndex}`}>
                            Selada em {version.sealedAtLabel}: <code>{version.sha256}</code>
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </section>
            )}

            {hasSealedVersions && <FileChecker items={result.items} />}

            <CopyLinkButton codigo={result.codigo} />
          </>
        )}
      </div>
    </div>
  );
}
