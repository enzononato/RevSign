import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { useOptionalSession } from '@documenso/lib/client-only/providers/session';
import { isSignupEnabledForProvider } from '@documenso/lib/constants/auth';
import { loadRecipientBrandingByTeamId } from '@documenso/lib/server-only/branding/load-recipient-branding';
import { getDocumentAndSenderByToken } from '@documenso/lib/server-only/document/get-document-by-token';
import { isRecipientAuthorized } from '@documenso/lib/server-only/document/is-recipient-authorized';
import { getFieldsForToken } from '@documenso/lib/server-only/field/get-fields-for-token';
import { getRecipientByToken } from '@documenso/lib/server-only/recipient/get-recipient-by-token';
import { getRecipientSignatures } from '@documenso/lib/server-only/recipient/get-recipient-signatures';
import { isWaitingForFinanceApproval } from '@documenso/lib/server-only/revalle/finance/seal-hold'; // REVALLE:
import {
  getRevalleGateLoaderPayload, // REVALLE:
  isRevalleGatePendingForToken, // REVALLE:
} from '@documenso/lib/server-only/revalle/gate/get-gate-state-for-loader'; // REVALLE:
import { getUserByEmail } from '@documenso/lib/server-only/user/get-user-by-email';
import { isDocumentCompleted } from '@documenso/lib/utils/document';
import { getEnvelopeItemPdfUrl } from '@documenso/lib/utils/envelope-download'; // REVALLE:
import { trpc } from '@documenso/trpc/react';
import { SigningCard } from '@documenso/ui/components/signing-card'; // REVALLE: cartão 2D, sem a imagem de comemoração
import { cn } from '@documenso/ui/lib/utils';
import { Button } from '@documenso/ui/primitives/button';
import { Card } from '@documenso/ui/primitives/card'; // REVALLE:
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { DocumentStatus, FieldType, RecipientRole } from '@prisma/client';
import { CheckCircle2, Clock8, DownloadIcon, EyeIcon, Loader2 } from 'lucide-react'; // REVALLE: EyeIcon
import { Link, redirect } from 'react-router'; // REVALLE: redirect
import { getOptionalLoaderContext } from 'server/utils/get-loader-session'; // REVALLE:
import { match } from 'ts-pattern';
import { EnvelopeDownloadDialog } from '~/components/dialogs/envelope-download-dialog';
import { ClaimAccount } from '~/components/general/claim-account';
import { DocumentSigningAuthPageView } from '~/components/general/document-signing/document-signing-auth-page';
import { RecipientBranding } from '~/components/general/recipient-branding';
import { GateStatusIcon } from '~/components/revalle/signing-gate/gate-status-icon'; // REVALLE:
import { SigningPageFrame } from '~/components/revalle/signing-gate/signing-band'; // REVALLE:
import { useCspNonce } from '~/utils/nonce';

import type { Route } from './+types/complete';

export async function loader({ params, request }: Route.LoaderArgs) {
  const { user } = await getOptionalSession(request);

  const { token } = params;

  if (!token) {
    throw new Response('Not Found', { status: 404 });
  }

  // REVALLE: nada do documento antes do portão; a tela do portão fica em /sign/<token>.
  const { requestMetadata } = getOptionalLoaderContext();

  if (await isRevalleGatePendingForToken(token, requestMetadata)) {
    if (await getRevalleGateLoaderPayload(token, requestMetadata)) {
      throw redirect(`/sign/${token}`);
    }

    throw new Response('Not Found', { status: 404 });
  }

  const document = await getDocumentAndSenderByToken({
    token,
    requireAccessAuth: false,
  }).catch(() => null);

  if (!document || !document.documentData) {
    throw new Response('Not Found', { status: 404 });
  }

  const branding = await loadRecipientBrandingByTeamId({ teamId: document.teamId });

  const [fields, recipient] = await Promise.all([
    getFieldsForToken({ token }),
    getRecipientByToken({ token }).catch(() => null),
  ]);

  if (!recipient) {
    throw new Response('Not Found', { status: 404 });
  }

  const isDocumentAccessValid = await isRecipientAuthorized({
    type: 'ACCESS',
    documentAuthOptions: document.authOptions,
    recipient,
    userId: user?.id,
  });

  if (!isDocumentAccessValid) {
    return {
      isDocumentAccessValid: false,
      recipientEmail: recipient.email,
      branding,
    } as const;
  }

  const signatures = await getRecipientSignatures({ recipientId: recipient.id });
  const isExistingUser = await getUserByEmail({ email: recipient.email })
    .then((u) => !!u)
    .catch(() => false);

  const recipientName =
    recipient.name || fields.find((field) => field.type === FieldType.NAME)?.customText || recipient.email;

  const canSignUp = !isExistingUser && isSignupEnabledForProvider('email');

  const canRedirectToFolder = user && document.userId === user.id && document.folderId && document.team?.url;

  const returnToHomePath = canRedirectToFolder ? `/t/${document.team.url}/documents/f/${document.folderId}` : '/';

  return {
    isDocumentAccessValid: true,
    canSignUp,
    recipientName,
    recipientEmail: recipient.email,
    signatures,
    document,
    recipient,
    returnToHomePath,
    branding,
    revalleAwaitingFinance: await isWaitingForFinanceApproval(document.envelopeId), // REVALLE:
  };
}

export default function CompletedSigningPage({ loaderData }: Route.ComponentProps) {
  const { _ } = useLingui();

  const { sessionData } = useOptionalSession();
  const user = sessionData?.user;
  const cspNonce = useCspNonce();

  const {
    isDocumentAccessValid,
    canSignUp,
    recipientName,
    signatures,
    document,
    recipient,
    recipientEmail,
    returnToHomePath,
    branding,
    revalleAwaitingFinance, // REVALLE:
  } = loaderData;

  // Poll signing status every few seconds
  const { data: signingStatusData } = trpc.envelope.signingStatus.useQuery(
    {
      token: recipient?.token || '',
    },
    {
      refetchInterval: 3000,
      // REVALLE: NF retida já sai do servidor com a espera pelo Financeiro (não "aguardando os outros")
      initialData: revalleAwaitingFinance
        ? ({ status: 'AWAITING_FINANCE' } as const)
        : match(document?.status)
            .with(DocumentStatus.COMPLETED, () => ({ status: 'COMPLETED' }) as const)
            .with(DocumentStatus.REJECTED, () => ({ status: 'REJECTED' }) as const)
            .with(DocumentStatus.PENDING, () => ({ status: 'PENDING' }) as const)
            .otherwise(() => ({ status: 'PENDING' }) as const),
    },
  );

  // Use signing status from query if available, otherwise fall back to document status
  const signingStatus = signingStatusData?.status ?? 'PENDING';

  if (!isDocumentAccessValid) {
    return (
      <>
        <RecipientBranding branding={branding} cspNonce={cspNonce} />
        <DocumentSigningAuthPageView email={recipientEmail} />
      </>
    );
  }

  // REVALLE (redesign v3): faixa azul + um cartão (estado, assinatura, ações); o "Criar conta" vem num segundo cartão.
  const status = match({ status: signingStatus, deletedAt: document.deletedAt })
    .with({ status: 'COMPLETED' }, () => ({
      tone: 'success' as const,
      icon: CheckCircle2,
      label: <Trans>Everyone has signed</Trans>,
      detail: <Trans>Everyone has signed! You will receive an email copy of the signed document.</Trans>,
    }))
    .with({ status: 'AWAITING_FINANCE' }, () => ({
      // REVALLE: NF retida até o Financeiro aprovar a conta
      tone: 'warning' as const,
      icon: Clock8,
      label: <Trans>Aguardando aprovação do Financeiro</Trans>,
      detail: <Trans>Você receberá o documento assinado por e-mail quando for aprovado.</Trans>,
    }))
    .with({ status: 'PROCESSING' }, () => ({
      tone: 'neutral' as const,
      icon: Loader2,
      label: <Trans>Processing document</Trans>,
      detail: (
        <Trans>
          All recipients have signed. The document is being processed and you will receive an email copy shortly.
        </Trans>
      ),
    }))
    .with({ deletedAt: null }, () => ({
      tone: 'warning' as const,
      icon: Clock8,
      label: <Trans>Waiting for others to sign</Trans>,
      detail: <Trans>You will receive an email copy of the signed document once everyone has signed.</Trans>,
    }))
    .otherwise(() => ({
      tone: 'danger' as const,
      icon: Clock8,
      label: <Trans>Document no longer available to sign</Trans>,
      detail: (
        <Trans>This document has been cancelled by the owner and is no longer available for others to sign.</Trans>
      ),
    }));

  const StatusIcon = status.icon;

  return (
    <>
      <RecipientBranding branding={branding} cspNonce={cspNonce} />
      <SigningPageFrame
        titleAs="p"
        title={<span title={document.title}>{document.title}</span>}
        after={
          canSignUp ? (
            <Card backdropBlur={false} className="mt-4 p-5 sm:p-7">
              <h2 className="font-black font-display text-[20px] leading-tight tracking-[-0.02em]">
                <Trans>Need to sign documents?</Trans>
              </h2>

              <p className="mt-2 text-muted-foreground leading-normal">
                <Trans>Create your account and start using state-of-the-art document signing.</Trans>
              </p>

              <ClaimAccount defaultName={recipientName} defaultEmail={recipient.email} />
            </Card>
          ) : null
        }
      >
        <div className="flex flex-col items-center text-center">
          <GateStatusIcon icon={CheckCircle2} tone={status.tone === 'danger' ? 'danger' : 'success'} />

          <h1 className="mt-4 font-black font-display text-[26px] leading-tight tracking-[-0.02em]">
            {recipient.role === RecipientRole.SIGNER && <Trans>Document Signed</Trans>}
            {recipient.role === RecipientRole.VIEWER && <Trans>Document Viewed</Trans>}
            {recipient.role === RecipientRole.APPROVER && <Trans>Document Approved</Trans>}
          </h1>

          <span
            className={cn(
              'mt-3 inline-flex min-h-7 items-center gap-1.5 rounded-full px-3 py-1 font-semibold text-[13px]',
              status.tone === 'success' && 'bg-success-bg text-success',
              status.tone === 'warning' && 'bg-warning-bg text-warning-text',
              status.tone === 'neutral' && 'bg-muted text-muted-foreground',
              status.tone === 'danger' && 'bg-danger-bg text-destructive',
            )}
          >
            <StatusIcon
              aria-hidden
              className={cn('h-4 w-4 flex-shrink-0', status.tone === 'neutral' && 'animate-spin')}
            />
            {status.label}
          </span>

          <p className="mt-3 max-w-[46ch] text-[14.5px] text-muted-foreground">{status.detail}</p>

          {/* Card with recipient */}
          <SigningCard className="mt-6 max-w-sm md:max-w-sm" name={recipientName} signature={signatures.at(0)} />

          <div className="mt-6 flex w-full flex-col items-stretch gap-3">
            {/* REVALLE: sem o "Compartilhar" (cartão para X/Twitter e link público): documento interno não vai para rede social */}

            {isDocumentCompleted(document) && (
              <EnvelopeDownloadDialog
                envelopeId={document.envelopeId}
                envelopeStatus={document.status}
                envelopeItems={document.envelopeItems}
                token={recipient?.token}
                trigger={
                  <Button
                    type="button"
                    variant="outline"
                    // REVALLE: min-h-11 (44 px de área de toque; na coluna do celular o flex-1 encolhia a altura)
                    className="min-h-11 w-full"
                  >
                    <DownloadIcon className="mr-2 h-5 w-5" />
                    <Trans>Download</Trans>
                  </Button>
                }
              />
            )}

            {/* REVALLE: enquanto o documento não conclui (a nota fiscal pode esperar dias o Financeiro), quem assinou ainda
                abre o PDF de cada arquivo, em nova aba, pelo endpoint de arquivo do próprio token */}
            {!isDocumentCompleted(document) &&
              document.deletedAt === null &&
              signingStatus !== 'REJECTED' &&
              [...document.envelopeItems]
                .sort((a, b) => a.order - b.order)
                .map((item) => (
                  <Button key={item.id} asChild type="button" variant="outline" className="min-h-11 w-full">
                    <a
                      href={getEnvelopeItemPdfUrl({ type: 'view', envelopeItem: item, token: recipient.token })}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid="complete-view-document"
                    >
                      <EyeIcon className="mr-2 h-5 w-5 flex-shrink-0" />
                      <span className="truncate">
                        {document.envelopeItems.length > 1 ? (
                          <Trans>Ver documento: {item.title}</Trans>
                        ) : (
                          <Trans>Ver documento</Trans>
                        )}
                      </span>
                    </a>
                  </Button>
                ))}

            {user && (
              <Button asChild size="lg" className="w-full">
                <Link to={returnToHomePath}>
                  <Trans>Go Back Home</Trans>
                </Link>
              </Button>
            )}
          </div>
        </div>
      </SigningPageFrame>
    </>
  );
}
