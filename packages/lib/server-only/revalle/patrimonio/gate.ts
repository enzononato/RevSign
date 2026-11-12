// REVALLE: integração com o Patrimônio. O portão de assinatura pergunta aqui se o destinatário assina um termo do
// Patrimônio e, se sim, qual CPF o Patrimônio informou (o único aceito).

import { prisma } from '@documenso/prisma';

/** CPF do termo (11 números) quando o destinatário é de um termo do Patrimônio; null nos outros documentos. */
export const findPatrimonioSignerCpf = async (recipientId: number): Promise<string | null> => {
  const termo = await prisma.revallePatrimonioTermo.findFirst({
    where: { envelope: { recipients: { some: { id: recipientId } } } },
    select: { signerCpf: true },
  });

  return termo?.signerCpf ?? null;
};
