import { prisma } from '@documenso/prisma';
import type { RecipientRole } from '@prisma/client';

import { buildRevalleCertificateRows, type RevalleCertificateRow } from '../../revalle/certificate-rows';
import { revalleRoleVerb } from '../../revalle/role-verbs';

export type RevalleCertificateRecipient = {
  rows: RevalleCertificateRow[];
  device: string | null;
  signedAt: Date;
  signedVerb: string;
  /** SIGNER que concluiu sem desenho nem texto: a marca no documento é só o carimbo. */
  isStampOnly: boolean;
};

export type RevalleCertificateData = {
  recipients: Map<number, RevalleCertificateRecipient>;
  headerLines: string[];
};

type LoadRevalleCertificateDataOptions = {
  envelopeId: string;
  recipients: { id: number; role: RecipientRole }[];
  /** Na selagem cada item tem seu certificado; sem ele (download avulso), todos os itens do envelope. */
  envelopeItemId?: string;
};

export const loadRevalleCertificateData = async ({
  envelopeId,
  recipients,
  envelopeItemId,
}: LoadRevalleCertificateDataOptions): Promise<RevalleCertificateData> => {
  const [proofs, hashes] = await Promise.all([
    prisma.revalleSignatureProof.findMany({
      where: { recipientId: { in: recipients.map((recipient) => recipient.id) } },
    }),
    prisma.revalleDocumentHash.findMany({
      where: envelopeItemId ? { envelopeItemId } : { envelopeItem: { envelopeId } },
      select: { originalSha256: true, envelopeItem: { select: { title: true, order: true } } },
    }),
  ]);

  const roles = new Map(recipients.map((recipient) => [recipient.id, recipient.role]));
  const byRecipient = new Map<number, RevalleCertificateRecipient>();

  for (const proof of proofs) {
    const role = roles.get(proof.recipientId);

    if (!role) {
      continue;
    }

    byRecipient.set(proof.recipientId, {
      rows: buildRevalleCertificateRows(proof, { role }),
      device: proof.device,
      signedAt: proof.signedAt,
      signedVerb: revalleRoleVerb(role),
      isStampOnly: role === 'SIGNER' && proof.signatureKind === 'NONE',
    });
  }

  const sortedHashes = [...hashes].sort((a, b) => a.envelopeItem.order - b.envelopeItem.order);
  const headerLines = sortedHashes.map((hash) =>
    sortedHashes.length > 1
      ? `SHA-256 do original (${hash.envelopeItem.title}): ${hash.originalSha256}`
      : `SHA-256 do original: ${hash.originalSha256}`,
  );

  return { recipients: byRecipient, headerLines };
};
