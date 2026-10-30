import { prisma } from '@documenso/prisma';
import type { RecipientRole } from '@prisma/client';
import { RevalleFinanceStatus, RevalleInvoiceStatus } from '@prisma/client';

import {
  buildRevalleCertificateRows,
  buildRevalleInvoiceCertificateLine,
  getRevalleSigningPositions,
  type RevalleCertificateRow,
} from '../../revalle/certificate-rows';
import { revalleRoleVerb } from '../../revalle/role-verbs';

export type RevalleCertificateRecipient = {
  rows: RevalleCertificateRow[];
  device: string | null;
  signedAt: Date;
  signedVerb: string;
  /** SIGNER que concluiu sem desenho nem texto: a marca no documento é só o carimbo. */
  isStampOnly: boolean;
};

/** Linha do cabeçalho de cada página da tabela: o hash quebra em qualquer caractere, o texto da conta por palavra. */
export type RevalleCertificateHeaderLine = { text: string; wrap: 'char' | 'word' };

export type RevalleCertificateData = {
  recipients: Map<number, RevalleCertificateRecipient>;
  headerLines: RevalleCertificateHeaderLine[];
};

type LoadRevalleCertificateDataOptions = {
  envelopeId: string;
  recipients: { id: number; role: RecipientRole; signingOrder: number | null }[];
  /** Na selagem cada item tem seu certificado; sem ele (download avulso), todos os itens do envelope. */
  envelopeItemId?: string;
};

export const loadRevalleCertificateData = async ({
  envelopeId,
  recipients,
  envelopeItemId,
}: LoadRevalleCertificateDataOptions): Promise<RevalleCertificateData> => {
  const [proofs, hashes, meta, invoiceLine] = await Promise.all([
    prisma.revalleSignatureProof.findMany({
      where: { recipientId: { in: recipients.map((recipient) => recipient.id) } },
    }),
    prisma.revalleDocumentHash.findMany({
      where: envelopeItemId ? { envelopeItemId } : { envelopeItem: { envelopeId } },
      select: { originalSha256: true, envelopeItem: { select: { title: true, order: true } } },
    }),
    prisma.envelope.findUnique({
      where: { id: envelopeId },
      select: { documentMeta: { select: { signingOrder: true } } },
    }),
    loadInvoiceLine(envelopeId),
  ]);

  // Ordem de assinatura só existe (e só aparece) em documento sequencial.
  const positions = getRevalleSigningPositions(recipients, meta?.documentMeta?.signingOrder);

  const roles = new Map(recipients.map((recipient) => [recipient.id, recipient.role]));
  const byRecipient = new Map<number, RevalleCertificateRecipient>();

  for (const proof of proofs) {
    const role = roles.get(proof.recipientId);

    if (!role) {
      continue;
    }

    byRecipient.set(proof.recipientId, {
      rows: buildRevalleCertificateRows(proof, { role, signingPosition: positions.get(proof.recipientId) }),
      device: proof.device,
      signedAt: proof.signedAt,
      signedVerb: revalleRoleVerb(role),
      isStampOnly: role === 'SIGNER' && proof.signatureKind === 'NONE',
    });
  }

  const sortedHashes = [...hashes].sort((a, b) => a.envelopeItem.order - b.envelopeItem.order);
  const headerLines: RevalleCertificateHeaderLine[] = sortedHashes.map((hash) => ({
    text:
      sortedHashes.length > 1
        ? `SHA-256 do original (${hash.envelopeItem.title}): ${hash.originalSha256}`
        : `SHA-256 do original: ${hash.originalSha256}`,
    wrap: 'char',
  }));

  if (invoiceLine) {
    headerLines.push({ text: invoiceLine, wrap: 'word' });
  }

  return { recipients: byRecipient, headerLines };
};

/**
 * Fase 6: NF aprovada pelo Financeiro ganha a linha da conta e da aprovação. Uma versão já concluída que depois foi
 * substituída continua aprovada (a reselagem dela mantém a linha); pendente de aprovação, `LEGACY` (de antes da Fase 6)
 * e documento comum, nada.
 */
const loadInvoiceLine = async (envelopeId: string): Promise<string | null> => {
  const row = await prisma.revalleInvoiceClassification.findUnique({
    where: { envelopeId },
    select: {
      isInvoice: true,
      financeStatus: true,
      choiceCode: true,
      choiceDefer: true,
      approvedById: true,
      approvedAt: true,
      approvedAccountName: true,
    },
  });

  const isApproved =
    row?.financeStatus === RevalleFinanceStatus.APPROVED ||
    (row?.financeStatus === RevalleFinanceStatus.SUPERSEDED && row.approvedAt !== null);

  if (
    !row ||
    row.isInvoice !== RevalleInvoiceStatus.YES ||
    !isApproved ||
    row.choiceDefer ||
    !row.choiceCode ||
    !row.approvedAt ||
    row.approvedById === null
  ) {
    return null;
  }

  // O nome congelado na aprovação; só as linhas aprovadas antes dessa coluna usam o nome atual da lista.
  const [account, approver] = await Promise.all([
    row.approvedAccountName === null
      ? prisma.revalleAccountingAccount.findUnique({ where: { code: row.choiceCode }, select: { name: true } })
      : null,
    prisma.user.findUnique({ where: { id: row.approvedById }, select: { name: true } }),
  ]);

  return buildRevalleInvoiceCertificateLine({
    code: row.choiceCode,
    name: row.approvedAccountName ?? account?.name ?? '',
    // Sem nome, "Financeiro": o e-mail de quem aprovou não vai para o PDF.
    approverName: approver?.name?.trim() || 'Financeiro',
    approvedAt: row.approvedAt,
  });
};
