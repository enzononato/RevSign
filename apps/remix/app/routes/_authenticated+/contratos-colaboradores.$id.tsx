import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { isAdmin } from '@documenso/lib/utils/is-admin';
import { prisma } from '@documenso/prisma';
import { msg } from '@lingui/core/macro';
import { redirect } from 'react-router';

import { ContractStatus } from '~/components/revalle/collaborator-contract-page/contract-status';
import { newContractPath } from '~/components/revalle/collaborator-contract-page/contract-ui';
import { appMetaTags } from '~/utils/meta';

import type { Route } from './+types/contratos-colaboradores.$id';

// REVALLE (v.22): página do contrato (acompanhamento), só administrador. Rascunho abre no assistente.

export function meta() {
  return appMetaTags(msg`Contratos para colaboradores`);
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const { user } = await getOptionalSession(request);

  if (!user || !isAdmin(user)) {
    throw redirect('/');
  }

  const contract = await prisma.revalleCollaboratorContract.findUnique({
    where: { id: params.id },
    select: { status: true },
  });

  if (contract?.status === 'DRAFT') {
    throw redirect(newContractPath(params.id));
  }

  return { contractId: params.id };
}

export default function CollaboratorContractStatusPage({ loaderData }: Route.ComponentProps) {
  return <ContractStatus key={loaderData.contractId} contractId={loaderData.contractId} />;
}
