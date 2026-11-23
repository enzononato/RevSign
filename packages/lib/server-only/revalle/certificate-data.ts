import { prisma } from '@documenso/prisma';
import type { RecipientRole } from '@prisma/client';
import { RevalleFinanceStatus, RevalleInvoiceFileKind, RevalleInvoiceStatus } from '@prisma/client';

import {
  buildRevalleCertificateRows,
  buildRevalleInvoiceCertificateLine,
  buildRevalleInvoiceCostCenterCertificateLine,
  getRevalleSigningPositions,
  invoiceDocumentLabel,
  type RevalleCertificateRow,
} from '../../revalle/certificate-rows';
import { fileFinanceStatus, invoicePositions } from '../../revalle/invoice/invoice-files';
import { revalleRoleVerb } from '../../revalle/role-verbs';
import { loadCollaboratorContractLine } from './collaborator-contract/marker';
import { loadInvoiceFiles } from './invoice/invoice-files';

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
  const [proofs, hashes, meta, invoiceLines, costCenterLine, collaboratorContractLine] = await Promise.all([
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
    loadInvoiceLines(envelopeId),
    loadCostCenterLine(envelopeId),
    loadCollaboratorContractLine(envelopeId),
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

  // Fase 9: com 2+ notas, as linhas de cada nota (conta aprovada e centro, com o rótulo dela), na ordem dos arquivos, em
  // todo arquivo selado do envio; com uma nota, as duas linhas de sempre.
  if (Array.isArray(invoiceLines)) {
    headerLines.push(...invoiceLines.map((text) => ({ text, wrap: 'word' as const })));
  } else {
    if (invoiceLines) {
      headerLines.push({ text: invoiceLines, wrap: 'word' });
    }

    if (costCenterLine) {
      headerLines.push({ text: costCenterLine, wrap: 'word' });
    }
  }

  // v.21, contrato para colaboradores: "Assinado pela empresa: {representante} em {data}, código {código}".
  if (collaboratorContractLine) {
    headerLines.push({ text: collaboratorContractLine.text, wrap: 'word' });
  }

  return { recipients: byRecipient, headerLines };
};

/**
 * Fase 9: com 2+ notas no envio, as linhas de cada nota (a conta aprovada, como `loadInvoiceLine`, e o centro, como
 * `loadCostCenterLine`), cada uma com "Nota 1 de 3 (nf-a.pdf): " na frente. Com uma nota (ou envio de antes da Fase 9
 * sem as linhas por arquivo), a linha de sempre (string ou null), lida da linha do envio.
 */
const loadInvoiceLines = async (envelopeId: string): Promise<string[] | string | null> => {
  const row = await prisma.revalleInvoiceClassification.findUnique({
    where: { envelopeId },
    select: { isInvoice: true, financeStatus: true },
  });

  if (!row || row.isInvoice !== RevalleInvoiceStatus.YES) {
    return null;
  }

  const files = await loadInvoiceFiles(envelopeId);
  const nfs = files.filter((file) => file.kind === RevalleInvoiceFileKind.NF);

  if (nfs.length < 2) {
    return await loadInvoiceLine(envelopeId);
  }

  const positions = invoicePositions(files);
  const lines: string[] = [];

  for (const file of nfs) {
    const position = positions.get(file.id);

    if (!position) {
      continue;
    }

    const documentLabel = invoiceDocumentLabel(position, file.title);
    const accountLine = await buildApprovedAccountLine({
      financeStatus: fileFinanceStatus(row.financeStatus, file.approvedAt),
      choiceCode: file.choiceCode,
      approvedById: file.approvedById,
      approvedAt: file.approvedAt,
      approvedAccountName: file.approvedAccountName,
      approvedByName: file.approvedByName,
      documentLabel,
    });

    if (accountLine) {
      lines.push(accountLine);
    }

    if (file.costCenterCode) {
      lines.push(buildRevalleInvoiceCostCenterCertificateLine(file.costCenterCode, documentLabel));
    }
  }

  return lines;
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
      approvedById: true,
      approvedAt: true,
      approvedAccountName: true,
      approvedByName: true,
    },
  });

  if (!row || row.isInvoice !== RevalleInvoiceStatus.YES) {
    return null;
  }

  return await buildApprovedAccountLine(row);
};

/**
 * A linha da conta aprovada (de uma nota ou da nota única): só aprovada, ou já aprovada numa versão depois substituída
 * (a reselagem dela mantém a linha), com a conta, quem aprovou e quando.
 */
const buildApprovedAccountLine = async (row: {
  financeStatus: RevalleFinanceStatus | null;
  choiceCode: string | null;
  approvedById: number | null;
  approvedAt: Date | null;
  approvedAccountName: string | null;
  approvedByName: string | null;
  documentLabel?: string;
}): Promise<string | null> => {
  const isApproved =
    row.financeStatus === RevalleFinanceStatus.APPROVED ||
    (row.financeStatus === RevalleFinanceStatus.SUPERSEDED && row.approvedAt !== null);

  if (!isApproved || !row.choiceCode || !row.approvedAt || row.approvedById === null) {
    return null;
  }

  // O nome congelado na aprovação; só as linhas aprovadas antes dessa coluna usam o nome atual da lista.
  const [account, approver] = await Promise.all([
    row.approvedAccountName === null
      ? prisma.revalleAccountingAccount.findUnique({ where: { code: row.choiceCode }, select: { name: true } })
      : null,
    row.approvedByName === null
      ? prisma.user.findUnique({ where: { id: row.approvedById }, select: { name: true } })
      : null,
  ]);

  return buildRevalleInvoiceCertificateLine({
    code: row.choiceCode,
    name: row.approvedAccountName ?? account?.name ?? '',
    // O nome congelado na aprovação (só as linhas de antes dessa coluna usam o atual). Sem nome, "Financeiro": o e-mail
    // de quem aprovou não vai para o PDF.
    approverName: row.approvedByName ?? (approver?.name?.trim() || 'Financeiro'),
    approvedAt: row.approvedAt,
    documentLabel: row.documentLabel,
  });
};

/**
 * Fase 7: qualquer NF com centro de custo ganha a linha dele no certificado, com ou sem aprovação do Financeiro (a
 * concluída como `LEGACY` também). A linha só diz qual é o centro: a validação da Contabilidade pode acontecer depois
 * da selagem, então o certificado não a afirma. NF sem centro e documento comum, nada.
 */
const loadCostCenterLine = async (envelopeId: string): Promise<string | null> => {
  const row = await prisma.revalleInvoiceClassification.findUnique({
    where: { envelopeId },
    select: { isInvoice: true, costCenterCode: true },
  });

  if (!row || row.isInvoice !== RevalleInvoiceStatus.YES || !row.costCenterCode) {
    return null;
  }

  return buildRevalleInvoiceCostCenterCertificateLine(row.costCenterCode);
};
