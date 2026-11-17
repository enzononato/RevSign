import { prisma } from '@documenso/prisma';

import { hrNameChange } from '../../../revalle/recipient-name';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import type { RequestMetadata } from '../../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { logger } from '../../../utils/logger';
import { getColaboradoresRepository } from '../colaboradores/repository';
import { revalleErrorCode } from '../error-code';

/**
 * Identidade conferida no portão: o nome do destinatário passa a ser o nome do RH, mesmo que já houvesse outro. Só grava
 * (e registra o evento, com o nome antigo e o novo, nunca o CPF) quando o nome muda; RH sem nome não troca nada.
 * Falha aqui não derruba o portão: a identidade já foi gravada e o nome fica como estava.
 */
export const applyRevalleHrName = async ({
  recipientId,
  hrName,
  requestMetadata,
}: {
  recipientId: number;
  hrName: string | null | undefined;
  requestMetadata?: RequestMetadata;
}): Promise<void> => {
  try {
    const recipient = await prisma.recipient.findUnique({
      where: { id: recipientId },
      select: { name: true, email: true, envelopeId: true },
    });

    const change = recipient ? hrNameChange(recipient.name, hrName) : null;

    if (!recipient || !change) {
      return;
    }

    await prisma.$transaction(async (tx) => {
      // Só troca o nome que foi lido: com o portão rodando duas vezes ao mesmo tempo, só uma grava e registra.
      const { count } = await tx.recipient.updateMany({
        where: { id: recipientId, name: recipient.name },
        data: { name: change.to },
      });

      if (count === 0) {
        return;
      }

      await tx.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_RECIPIENT_NAME_FROM_HR,
          envelopeId: recipient.envelopeId,
          data: { recipientId, from: change.from, to: change.to },
          user: { name: change.to, email: recipient.email },
          requestMetadata,
        }),
      });
    });
  } catch (error) {
    logger.error({
      msg: '[RevSign] nome do RH não gravado no destinatário',
      recipientId,
      code: revalleErrorCode(error),
    });
  }
};

/** Igual a `applyRevalleHrName`, buscando o nome pelo CPF já conferido. Base fora do ar: o nome fica como estava. */
export const applyRevalleHrNameByCpf = async ({
  recipientId,
  cpf,
  requestMetadata,
}: {
  recipientId: number;
  cpf: string;
  requestMetadata?: RequestMetadata;
}): Promise<void> => {
  let hrName: string | null;

  try {
    const repository = getColaboradoresRepository();

    if (!repository) {
      return;
    }

    hrName = (await repository.findByCpf(cpf))?.nome ?? null;
  } catch (error) {
    logger.error({ msg: '[RevSign] base de colaboradores indisponível para o nome', code: revalleErrorCode(error) });

    return;
  }

  await applyRevalleHrName({ recipientId, hrName, requestMetadata });
};
