import { useSession } from '@documenso/lib/client-only/providers/session';
import { DO_NOT_INVALIDATE_QUERY_ON_MUTATION } from '@documenso/lib/constants/trpc';
import { AppError } from '@documenso/lib/errors/app-error';
import { isAdmin } from '@documenso/lib/utils/is-admin';
import { formatTemplatesPath } from '@documenso/lib/utils/teams';
import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { Trans, useLingui } from '@lingui/react/macro';
import { DocumentStatus } from '@prisma/client';
import { useNavigate } from 'react-router';

import { useCurrentTeam } from '~/providers/team';

import { InvoiceCard } from '../invoice/invoice-ui';

export type CollaboratorContractButtonProps = {
  envelope: { id: string; status: DocumentStatus };
};

/**
 * REVALLE (v.21): no documento concluído, só para o admin, "Usar como contrato para colaboradores". Cria no time aberto
 * um modelo com as páginas assinadas (sem certificado e auditoria) e um signatário genérico, e abre o editor para
 * posicionar a assinatura do colaborador. Se o documento já virou contrato neste time, abre o modelo dele.
 */
export const CollaboratorContractButton = ({ envelope }: CollaboratorContractButtonProps) => {
  const { user } = useSession();
  const { t } = useLingui();
  const { toast } = useToast();
  const navigate = useNavigate();
  const team = useCurrentTeam();

  const isVisible = isAdmin(user) && envelope.status === DocumentStatus.COMPLETED;

  const { data: existing } = trpc.revalle.collaboratorContract.findForSource.useQuery(
    { envelopeId: envelope.id, teamId: team.id },
    { ...DO_NOT_INVALIDATE_QUERY_ON_MUTATION, enabled: isVisible },
  );

  const { mutateAsync: createFromEnvelope, isPending } =
    trpc.revalle.collaboratorContract.createFromEnvelope.useMutation();

  if (!isVisible || !existing) {
    return null;
  }

  const templatesPath = formatTemplatesPath(team.url);

  const onCreate = async () => {
    try {
      const result = await createFromEnvelope({ envelopeId: envelope.id, teamId: team.id });

      await navigate(
        result.created
          ? `${templatesPath}/${result.templateEnvelopeId}/edit`
          : `${templatesPath}/${result.templateEnvelopeId}`,
      );
    } catch (err) {
      const error = AppError.parseError(err);

      toast({
        title: error.userMessage || t`Não foi possível criar o modelo. Tente de novo.`,
        variant: 'destructive',
        duration: 7500,
      });
    }
  };

  return (
    <InvoiceCard title={<Trans>Contrato para colaboradores</Trans>} testId="collaborator-contract-card">
      <p className="text-muted-foreground">
        {existing.templateEnvelopeId ? (
          <Trans>Este documento já virou um modelo para os colaboradores assinarem.</Trans>
        ) : (
          <Trans>
            Cria um modelo com as páginas assinadas, para cada colaborador receber o seu documento por e-mail e assinar.
          </Trans>
        )}
      </p>

      {existing.templateEnvelopeId ? (
        <Button
          type="button"
          variant="outline"
          className="w-full whitespace-normal"
          onClick={() => void navigate(`${templatesPath}/${existing.templateEnvelopeId}`)}
        >
          <Trans>Abrir contrato para colaboradores</Trans>
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          className="w-full whitespace-normal"
          loading={isPending}
          onClick={() => void onCreate()}
          data-testid="collaborator-contract-create"
        >
          <Trans>Usar como contrato para colaboradores</Trans>
        </Button>
      )}
    </InvoiceCard>
  );
};
