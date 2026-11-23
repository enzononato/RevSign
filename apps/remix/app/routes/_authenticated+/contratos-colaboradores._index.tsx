import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { formatRevalleDateTime } from '@documenso/lib/revalle/date-format';
import { isAdmin } from '@documenso/lib/utils/is-admin';
import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { ChevronRightIcon, PlusIcon } from 'lucide-react';
import { Link, redirect } from 'react-router';

import {
  ContractStatusPill,
  contractPath,
  EmptyState,
  formatCount,
  newContractPath,
} from '~/components/revalle/collaborator-contract-page/contract-ui';
import { appMetaTags } from '~/utils/meta';

import type { Route } from './+types/contratos-colaboradores._index';

// REVALLE (v.22): lista "Contratos para colaboradores" (só administrador do sistema).

export function meta() {
  return appMetaTags(msg`Contratos para colaboradores`);
}

export async function loader({ request }: Route.LoaderArgs) {
  const { user } = await getOptionalSession(request);

  if (!user || !isAdmin(user)) {
    throw redirect('/');
  }

  return null;
}

export default function CollaboratorContractsPage() {
  const { data, isPending, isError, refetch } = trpc.revalle.collaboratorContract.page.list.useQuery(undefined, {
    refetchInterval: 30_000,
  });

  const contracts = data?.contracts ?? [];

  return (
    <div className="mx-auto w-full min-w-0 max-w-screen-lg px-4 md:px-8" data-testid="contracts-page">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className="font-black font-display text-[30px] leading-[1.05] tracking-[-0.03em] md:text-[36px]">
            <Trans>Contratos para colaboradores</Trans>
          </h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">
            <Trans>
              Um contrato assinado pelo representante da empresa e enviado para cada colaborador assinar, com o
              acompanhamento de quem já assinou.
            </Trans>
          </p>
        </div>

        {contracts.length > 0 && (
          <Button asChild>
            <Link to={newContractPath()} data-testid="contracts-new">
              <PlusIcon className="mr-2 h-4 w-4" aria-hidden />
              <Trans>Novo contrato</Trans>
            </Link>
          </Button>
        )}
      </div>

      <div className="mt-6 flex flex-col gap-2.5" data-testid="contracts-list">
        {contracts.map((contract) => {
          const isDraft = contract.status === 'DRAFT';
          const href = isDraft ? newContractPath(contract.id) : contractPath(contract.id);
          const total = formatCount(contract.total);
          const signed = formatCount(contract.signed);

          return (
            <Link
              key={contract.id}
              to={href}
              className="group flex min-w-0 items-center gap-4 rounded-card bg-card px-5 py-4 shadow-card transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              data-testid="contracts-row"
              data-status={contract.status}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <p className="min-w-0 break-words font-bold text-[15.5px]">
                    {contract.title || <Trans>Sem título</Trans>}
                  </p>
                  <ContractStatusPill status={contract.status} />
                </div>
                <p className="mt-1 text-muted-foreground text-sm">
                  {isDraft ? (
                    <Trans>Rascunho: continue de onde parou.</Trans>
                  ) : contract.total > 0 ? (
                    <Trans>
                      {signed} de {total} assinaram
                    </Trans>
                  ) : (
                    <Trans>Nenhum documento enviado ainda.</Trans>
                  )}
                  <span aria-hidden> · </span>
                  <Trans>criado em {formatRevalleDateTime(contract.createdAt)}</Trans>
                  {contract.isLegacy && (
                    <>
                      <span aria-hidden> · </span>
                      <Trans>versão anterior</Trans>
                    </>
                  )}
                </p>
              </div>

              <span className="hidden shrink-0 items-center gap-1 font-bold text-brand-text text-sm sm:inline-flex">
                {isDraft ? <Trans>Continuar</Trans> : <Trans>Acompanhar</Trans>}
                <ChevronRightIcon className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
              </span>
            </Link>
          );
        })}

        {data && contracts.length === 0 && (
          <EmptyState testId="contracts-empty">
            <p className="max-w-md">
              <Trans>
                Nenhum contrato ainda. Suba o PDF, escolha o representante e cole a lista de colaboradores: o envio
                começa sozinho depois que o representante assinar.
              </Trans>
            </p>
            <Button asChild>
              <Link to={newContractPath()} data-testid="contracts-new">
                <PlusIcon className="mr-2 h-4 w-4" aria-hidden />
                <Trans>Novo contrato</Trans>
              </Link>
            </Button>
          </EmptyState>
        )}

        {!data && (
          <EmptyState>
            {isError && !isPending ? (
              <>
                <p>
                  <Trans>Não foi possível carregar os contratos. Tente de novo.</Trans>
                </p>
                <Button variant="outline" onClick={() => void refetch()}>
                  <Trans>Tentar de novo</Trans>
                </Button>
              </>
            ) : (
              <p>
                <Trans>Carregando…</Trans>
              </p>
            )}
          </EmptyState>
        )}
      </div>
    </div>
  );
}
