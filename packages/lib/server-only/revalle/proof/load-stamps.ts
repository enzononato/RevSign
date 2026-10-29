import { prisma } from '@documenso/prisma';
import { RecipientRole } from '@prisma/client';

import { NEXT_PUBLIC_WEBAPP_URL } from '../../../constants/app';
import { buildRevalleStampLines, type RevalleStamp } from '../../../revalle/stamp';

/**
 * Carimbos por recipientId, montados só a partir da prova congelada. Só SIGNER tem carimbo; APPROVER/ASSISTANT e
 * destinatário sem prova (documento anterior à Fase 4) ficam fora do mapa e o campo sai como no upstream.
 */
export const loadRevalleStamps = async (envelopeId: string): Promise<Map<number, RevalleStamp>> => {
  const recipients = await prisma.recipient.findMany({
    where: { envelopeId, role: RecipientRole.SIGNER, revalleProof: { isNot: null } },
    select: {
      id: true,
      name: true,
      email: true,
      revalleProof: { select: { verificationCode: true, signedAt: true, employee: true } },
    },
  });

  const baseUrl = NEXT_PUBLIC_WEBAPP_URL();
  const stamps = new Map<number, RevalleStamp>();

  for (const recipient of recipients) {
    const proof = recipient.revalleProof;

    if (!proof) {
      continue;
    }

    const employee = (proof.employee ?? null) as { nome?: unknown; cpfMasked?: unknown } | null;

    stamps.set(recipient.id, {
      lines: buildRevalleStampLines({
        // Sem dados de colaborador (checagem de identidade desligada), vale o nome gravado ao concluir,
        // a mesma regra que a prova usa para `employee.nome`.
        nome:
          typeof employee?.nome === 'string' && employee.nome.trim()
            ? employee.nome
            : recipient.name || recipient.email,
        cpfMasked: typeof employee?.cpfMasked === 'string' ? employee.cpfMasked : null,
        signedAt: proof.signedAt,
        verificationCode: proof.verificationCode,
        baseUrl,
      }),
    });
  }

  return stamps;
};
