import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../../errors/app-error';

/** A organização marcada como unidade. Organização comum (ou apagada) = 404. */
export const getUnitOrThrow = async (organisationId: string) => {
  const unit = await prisma.revalleUnit.findUnique({
    where: { organisationId },
    select: {
      hrUnitName: true,
      organisation: { select: { id: true, name: true, ownerUserId: true } },
    },
  });

  if (!unit) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Unidade não encontrada.' });
  }

  return { ...unit.organisation, hrUnitName: unit.hrUnitName };
};
