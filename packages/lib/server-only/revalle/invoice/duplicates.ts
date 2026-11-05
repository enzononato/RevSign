import { prisma } from '@documenso/prisma';
import type { RevalleInvoiceClassification } from '@prisma/client';
import {
  DocumentStatus,
  EnvelopeType,
  type Prisma,
  RevalleFinanceStatus,
  RevalleInvoiceStatus,
  SigningStatus,
} from '@prisma/client';

import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';

/**
 * Fase 8, o alerta de nota duplicada. Uma NF é "possível duplicada" quando OUTRA NF viva tem uma chave de acesso em
 * comum com ela ou o mesmo arquivo (`fileSha256`, a chave de todos os arquivos do envelope), e a própria NF também está
 * viva. Viva = enviada (pendente ou concluída), não recusada, não cancelada, não excluída e não substituída por uma nova
 * versão. NFS-e com arquivo diferente não é achada: não tem chave de 44 dígitos.
 *
 * Nada aqui compara `null`: linha antiga sem hash e sem chaves não casa com ninguém.
 */
export type InvoiceDuplicate = {
  envelopeId: string;
  title: string;
  sentAt: Date | null;
  senderName: string;
  status: 'PENDING' | 'COMPLETED';
};

type DuplicateSearchRow = Pick<RevalleInvoiceClassification, 'accessKeys' | 'fileSha256'>;

/** Quantas outras notas o aviso lista. */
const MAX_DUPLICATES = 5;

const SENT = DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SENT;

// `not` do Prisma deixa de fora as linhas nulas (SQL `<>` com NULL): a NF ainda sem estado no Financeiro precisa entrar.
const isNotSuperseded = {
  OR: [{ financeStatus: null }, { financeStatus: { not: RevalleFinanceStatus.SUPERSEDED } }],
} satisfies Prisma.RevalleInvoiceClassificationWhereInput;

/** O envelope que vale como "a outra nota": enviado, sem recusa, sem cancelamento e sem exclusão. */
const liveSentEnvelope = {
  type: EnvelopeType.DOCUMENT,
  status: { in: [DocumentStatus.PENDING, DocumentStatus.COMPLETED] },
  deletedAt: null,
  recipients: { none: { signingStatus: SigningStatus.REJECTED } },
} satisfies Prisma.EnvelopeWhereInput;

/** "Mesma chave ou mesmo arquivo" para as linhas dadas; vazio quando nenhuma tem chave nem hash (nada a procurar). */
const matchConditions = (rows: DuplicateSearchRow[]) => {
  const keys = [...new Set(rows.flatMap((row) => row.accessKeys))];
  const hashes = [...new Set(rows.flatMap((row) => (row.fileSha256 === null ? [] : [row.fileSha256])))];

  return [
    ...(keys.length > 0 ? [{ accessKeys: { hasSome: keys } }] : []),
    ...(hashes.length > 0 ? [{ fileSha256: { in: hashes } }] : []),
  ] satisfies Prisma.RevalleInvoiceClassificationWhereInput[];
};

/** Data do envio: o primeiro evento DOCUMENT_SENT; sem ele (concluído direto no envio), a criação. */
export const sentAtOf = (envelope: { createdAt: Date; auditLogs: { createdAt: Date }[] }) =>
  envelope.auditLogs[0]?.createdAt ?? envelope.createdAt;

/**
 * As outras notas vivas com uma chave em comum ou o mesmo arquivo, do envio mais antigo para o mais novo (até 5). Vazio se
 * a própria NF não está viva: substituída, recusada, cancelada ou excluída não mostra o alerta. O rascunho conta como
 * vivo (é o aviso do envio). O chamador decide o que mostrar: o título e o id só vão a quem pode abrir a outra nota.
 */
export const findInvoiceDuplicates = async (
  row: Pick<RevalleInvoiceClassification, 'envelopeId' | 'accessKeys' | 'fileSha256' | 'financeStatus'>,
): Promise<InvoiceDuplicate[]> => {
  const match = matchConditions([row]);

  if (row.financeStatus === RevalleFinanceStatus.SUPERSEDED || match.length === 0) {
    return [];
  }

  const own = await prisma.envelope.findUnique({
    where: { id: row.envelopeId },
    select: {
      status: true,
      deletedAt: true,
      recipients: { where: { signingStatus: SigningStatus.REJECTED }, select: { id: true }, take: 1 },
    },
  });

  const isOwnAlive =
    own !== null &&
    own.deletedAt === null &&
    own.recipients.length === 0 &&
    (own.status === DocumentStatus.DRAFT ||
      own.status === DocumentStatus.PENDING ||
      own.status === DocumentStatus.COMPLETED);

  if (!isOwnAlive) {
    return [];
  }

  const others = await prisma.envelope.findMany({
    where: {
      ...liveSentEnvelope,
      id: { not: row.envelopeId },
      revalleInvoice: { isInvoice: RevalleInvoiceStatus.YES, AND: [isNotSuperseded, { OR: match }] },
    },
    select: {
      id: true,
      title: true,
      status: true,
      createdAt: true,
      user: { select: { name: true, email: true } },
      auditLogs: { where: { type: SENT }, orderBy: { createdAt: 'asc' }, take: 1, select: { createdAt: true } },
    },
  });

  return others
    .map((envelope) => ({ envelope, sentAt: sentAtOf(envelope) }))
    .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime() || (a.envelope.id < b.envelope.id ? -1 : 1))
    .slice(0, MAX_DUPLICATES)
    .map(({ envelope, sentAt }) => ({
      envelopeId: envelope.id,
      title: envelope.title,
      sentAt,
      senderName: envelope.user.name?.trim() || envelope.user.email,
      // O filtro acima só deixa PENDING e COMPLETED passarem.
      status: envelope.status === DocumentStatus.COMPLETED ? 'COMPLETED' : 'PENDING',
    }));
};

/**
 * Em lote, para a lista e a planilha (até 10.000 linhas): quais destas NFs são possível duplicada. Duas consultas no
 * total (mais uma para os rascunhos de nova versão), nunca uma por linha: busca de uma vez as NFs vivas que casam com
 * qualquer chave ou arquivo do lote e cruza na memória.
 */
export const findDuplicateEnvelopeIds = async (
  rows: { envelopeId: string; accessKeys: string[]; fileSha256: string | null }[],
): Promise<Set<string>> => {
  const duplicated = new Set<string>();
  const searchable = rows.filter((row) => row.fileSha256 !== null || row.accessKeys.length > 0);
  const match = matchConditions(searchable);

  if (match.length === 0) {
    return duplicated;
  }

  const candidates = await prisma.revalleInvoiceClassification.findMany({
    where: { isInvoice: RevalleInvoiceStatus.YES, AND: [isNotSuperseded, { OR: match }], envelope: liveSentEnvelope },
    select: { envelopeId: true, accessKeys: true, fileSha256: true },
  });

  const byKey = new Map<string, string[]>();
  const byHash = new Map<string, string[]>();
  const add = (index: Map<string, string[]>, value: string, envelopeId: string) =>
    index.set(value, [...(index.get(value) ?? []), envelopeId]);

  for (const candidate of candidates) {
    for (const key of candidate.accessKeys) {
      add(byKey, key, candidate.envelopeId);
    }

    if (candidate.fileSha256 !== null) {
      add(byHash, candidate.fileSha256, candidate.envelopeId);
    }
  }

  // Uma NF enviada e viva aparece entre os candidatos (casa com ela mesma). Falta o rascunho de nova versão, que também
  // mostra o alerta (é a mesma regra da página) e não é "viva e enviada".
  const candidateIds = new Set(candidates.map((candidate) => candidate.envelopeId));
  const unseen = searchable.filter((row) => !candidateIds.has(row.envelopeId));
  const draftIds = new Set(
    unseen.length === 0
      ? []
      : (
          await prisma.envelope.findMany({
            where: {
              id: { in: unseen.map((row) => row.envelopeId) },
              type: EnvelopeType.DOCUMENT,
              status: DocumentStatus.DRAFT,
              deletedAt: null,
              revalleInvoice: { isInvoice: RevalleInvoiceStatus.YES, AND: [isNotSuperseded] },
            },
            select: { id: true },
          })
        ).map((envelope) => envelope.id),
  );

  const aliveIds = new Set([...candidateIds, ...draftIds]);

  for (const row of searchable) {
    if (!aliveIds.has(row.envelopeId)) {
      continue;
    }

    const sharing = [
      ...(row.fileSha256 === null ? [] : (byHash.get(row.fileSha256) ?? [])),
      ...row.accessKeys.flatMap((key) => byKey.get(key) ?? []),
    ];

    if (sharing.some((envelopeId) => envelopeId !== row.envelopeId)) {
      duplicated.add(row.envelopeId);
    }
  }

  return duplicated;
};
