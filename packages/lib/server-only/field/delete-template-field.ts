import { prisma } from '@documenso/prisma';
import { EnvelopeType } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { buildTeamWhereQuery } from '../../utils/teams';
import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';
import { assertCollaboratorContractMutable } from '../revalle/collaborator-contract/guard'; // REVALLE:

export interface DeleteTemplateFieldOptions {
  userId: number;
  teamId: number;
  fieldId: number;
}

export const deleteTemplateField = async ({ userId, teamId, fieldId }: DeleteTemplateFieldOptions): Promise<void> => {
  const field = await prisma.field.findFirst({
    where: {
      id: fieldId,
      envelope: {
        type: EnvelopeType.TEMPLATE,
        team: buildTeamWhereQuery({ teamId, userId }),
      },
    },
  });

  if (!field) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Field not found',
    });
  }

  // REVALLE: contrato para colaboradores (v.21): só o administrador do sistema altera.
  await assertCollaboratorContractMutable({ envelopeId: field.envelopeId, actor: { userId } });

  // Additional validation to check visibility.
  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id: {
      type: 'envelopeId',
      id: field.envelopeId,
    },
    type: EnvelopeType.TEMPLATE,
    userId,
    teamId,
  });

  await prisma.field.delete({
    where: {
      id: field.id,
      envelope: envelopeWhereInput,
    },
  });
};
