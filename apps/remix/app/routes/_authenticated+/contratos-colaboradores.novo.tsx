import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import {
  REVALLE_BULK_SEND_SWEEPS_PER_HOUR,
  revalleBulkSendBatchSize,
} from '@documenso/lib/revalle/collaborator-contract';
import { env } from '@documenso/lib/utils/env';
import { isAdmin } from '@documenso/lib/utils/is-admin';
import { msg } from '@lingui/core/macro';
import { useState } from 'react';
import { redirect, useSearchParams } from 'react-router';

import { ContractWizard } from '~/components/revalle/collaborator-contract-page/contract-wizard';
import { appMetaTags } from '~/utils/meta';

import type { Route } from './+types/contratos-colaboradores.novo';

// REVALLE (v.22): assistente "Novo contrato" (só administrador). `?id=` continua um rascunho.

export function meta() {
  return appMetaTags(msg`Novo contrato`);
}

export async function loader({ request }: Route.LoaderArgs) {
  const { user } = await getOptionalSession(request);

  if (!user || !isAdmin(user)) {
    throw redirect('/');
  }

  // O ritmo real da varredura (lote a cada 15 minutos × 4), para a estimativa do último passo.
  const perHour =
    revalleBulkSendBatchSize(env('NEXT_PRIVATE_REVALLE_BULK_SEND_PER_HOUR')) * REVALLE_BULK_SEND_SWEEPS_PER_HOUR;

  return { perHour };
}

export default function NewCollaboratorContractPage({ loaderData }: Route.ComponentProps) {
  const [searchParams] = useSearchParams();

  // O id só vale ao abrir: o assistente põe o id do rascunho novo no endereço sem recomeçar.
  const [draftId] = useState(() => searchParams.get('id'));

  return <ContractWizard key={draftId ?? 'novo'} draftId={draftId} perHour={loaderData.perHour} />;
}
