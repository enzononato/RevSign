import { prisma } from '@documenso/prisma';
import type { RevalleInvoiceClassification } from '@prisma/client';
import {
  DocumentStatus,
  EnvelopeType,
  type Prisma,
  RevalleFinanceStatus,
  RevalleInvoiceFileKind,
  RevalleInvoiceStatus,
  SigningStatus,
} from '@prisma/client';

import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import { logger } from '../../../utils/logger';

/**
 * Fase 8, o alerta de nota duplicada. Uma NF é "possível duplicada" quando OUTRA NF viva tem uma chave de acesso em
 * comum com ela ou o mesmo arquivo (`fileSha256`, a chave de todos os arquivos do envelope), e a própria NF também está
 * viva. Viva = enviada (pendente ou concluída), não recusada, não cancelada, não excluída e não substituída por uma nova
 * versão. NFS-e com arquivo diferente não é achada: não tem chave de 44 dígitos.
 *
 * Fase 9: a busca é por nota (linha de arquivo NF): as chaves e o SHA-256 do arquivo dela contra as notas de OUTROS
 * envios. O aviso do envio é a união das notas. A mesma nota duas vezes no mesmo envio é outro aviso (o do diálogo).
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
  ];
};

/** Data do envio: o primeiro evento DOCUMENT_SENT; sem ele (concluído direto no envio), a criação. */
export const sentAtOf = (envelope: { createdAt: Date; auditLogs: { createdAt: Date }[] }) =>
  envelope.auditLogs[0]?.createdAt ?? envelope.createdAt;

/** Envelope da própria nota vivo: rascunho, enviado ou concluído, sem recusa e sem exclusão. */
const isEnvelopeAlive = async (envelopeId: string): Promise<boolean> => {
  const own = await prisma.envelope.findUnique({
    where: { id: envelopeId },
    select: {
      status: true,
      deletedAt: true,
      recipients: { where: { signingStatus: SigningStatus.REJECTED }, select: { id: true }, take: 1 },
    },
  });

  return (
    own !== null &&
    own.deletedAt === null &&
    own.recipients.length === 0 &&
    (own.status === DocumentStatus.DRAFT ||
      own.status === DocumentStatus.PENDING ||
      own.status === DocumentStatus.COMPLETED)
  );
};

/** As outras NFs vivas (de outro envio) que casam com `match`, do envio mais antigo para o mais novo (até 5). */
const findOtherInvoices = async (
  envelopeId: string,
  revalleInvoice: Prisma.RevalleInvoiceClassificationWhereInput,
  extra: Prisma.EnvelopeWhereInput = {},
): Promise<InvoiceDuplicate[]> => {
  const others = await prisma.envelope.findMany({
    where: {
      ...liveSentEnvelope,
      ...extra,
      id: { not: envelopeId },
      revalleInvoice,
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

  return sortDuplicates(
    others.map((envelope) => ({
      envelopeId: envelope.id,
      title: envelope.title,
      sentAt: sentAtOf(envelope),
      senderName: envelope.user.name?.trim() || envelope.user.email,
      // O filtro acima só deixa PENDING e COMPLETED passarem.
      status: envelope.status === DocumentStatus.COMPLETED ? 'COMPLETED' : 'PENDING',
    })),
  );
};

/** Do envio mais antigo para o mais novo (empate pelo id), até 5. */
const sortDuplicates = (duplicates: InvoiceDuplicate[]): InvoiceDuplicate[] =>
  [...duplicates]
    .sort(
      (a, b) =>
        (a.sentAt?.getTime() ?? 0) - (b.sentAt?.getTime() ?? 0) ||
        (a.envelopeId < b.envelopeId ? -1 : a.envelopeId > b.envelopeId ? 1 : 0),
    )
    .slice(0, MAX_DUPLICATES);

/**
 * Fase 9: a união das duplicadas das notas de um envio (o aviso do envio), sem repetir a outra nota, do envio mais antigo
 * para o mais novo (até 5).
 */
export const unionInvoiceDuplicates = (lists: InvoiceDuplicate[][]): InvoiceDuplicate[] =>
  sortDuplicates([...new Map(lists.flat().map((duplicate) => [duplicate.envelopeId, duplicate])).values()]);

/**
 * As outras notas vivas com uma chave em comum ou o mesmo arquivo, do envio mais antigo para o mais novo (até 5). Vazio se
 * a própria NF não está viva: substituída, recusada, cancelada ou excluída não mostra o alerta. O rascunho conta como
 * vivo (é o aviso do envio). O chamador decide o que mostrar: o título e o id só vão a quem pode abrir a outra nota.
 *
 * Fase 9: lê a linha do envio (o espelho). Só vale para o envio de antes da Fase 9 ainda sem linhas de arquivo; o resto
 * usa `findInvoiceFileDuplicates` (por nota).
 */
export const findInvoiceDuplicates = async (
  row: Pick<RevalleInvoiceClassification, 'envelopeId' | 'accessKeys' | 'fileSha256' | 'financeStatus'>,
): Promise<InvoiceDuplicate[]> => {
  const match = matchConditions([row]);

  if (row.financeStatus === RevalleFinanceStatus.SUPERSEDED || match.length === 0) {
    return [];
  }

  if (!(await isEnvelopeAlive(row.envelopeId))) {
    return [];
  }

  return await findOtherInvoices(row.envelopeId, {
    isInvoice: RevalleInvoiceStatus.YES,
    AND: [isNotSuperseded, { OR: match }],
  });
};

type DuplicateSearchFile = { id: string; envelopeId: string; accessKeys: string[]; fileSha256: string | null };

/** "Outra NF (linha de arquivo) com uma chave em comum ou o mesmo arquivo" desta nota. */
const fileMatchWhere = (match: ReturnType<typeof matchConditions>): Prisma.EnvelopeWhereInput => ({
  revalleInvoiceFiles: { some: { kind: RevalleInvoiceFileKind.NF, OR: match } },
});

/**
 * Fase 9: as duplicadas de UMA nota: as NFs (linhas de arquivo) vivas de OUTROS envios com uma chave em comum ou o mesmo
 * arquivo (SHA-256 do arquivo dela, não do conjunto). A mesma nota duas vezes no mesmo envio não conta aqui (é o aviso
 * `sameEnvelopeDuplicateIndex`). Vazio se o envio dela não está vivo (`envelopeFinanceStatus` substituído, recusado,
 * cancelado ou excluído).
 */
export const findInvoiceFileDuplicates = async (
  file: DuplicateSearchFile,
  envelopeFinanceStatus: RevalleFinanceStatus | null,
): Promise<InvoiceDuplicate[]> => {
  const match = matchConditions([file]);

  if (envelopeFinanceStatus === RevalleFinanceStatus.SUPERSEDED || match.length === 0) {
    return [];
  }

  if (!(await isEnvelopeAlive(file.envelopeId))) {
    return [];
  }

  return await findOtherInvoices(
    file.envelopeId,
    { isInvoice: RevalleInvoiceStatus.YES, AND: [isNotSuperseded] },
    fileMatchWhere(match),
  );
};

/**
 * Fase 9: as duplicadas de cada nota de um envio (chave = id da linha do arquivo) e a união (o aviso do envio). Confere
 * uma vez só se o envio está vivo. Cada busca que falhar registra (sem dados) e fica vazia, como `...OrEmpty`.
 */
export const findEnvelopeNoteDuplicatesOrEmpty = async ({
  envelopeId,
  files,
  financeStatus,
}: {
  envelopeId: string;
  files: DuplicateSearchFile[];
  financeStatus: RevalleFinanceStatus | null;
}): Promise<{ byFile: Map<string, InvoiceDuplicate[]>; union: InvoiceDuplicate[] }> => {
  const byFile = new Map<string, InvoiceDuplicate[]>(files.map((file) => [file.id, []]));
  const searchable = files.filter((file) => matchConditions([file]).length > 0);

  if (financeStatus === RevalleFinanceStatus.SUPERSEDED || searchable.length === 0) {
    return { byFile, union: [] };
  }

  try {
    if (!(await isEnvelopeAlive(envelopeId))) {
      return { byFile, union: [] };
    }

    for (const file of searchable) {
      byFile.set(
        file.id,
        await findOtherInvoices(
          envelopeId,
          { isInvoice: RevalleInvoiceStatus.YES, AND: [isNotSuperseded] },
          fileMatchWhere(matchConditions([file])),
        ),
      );
    }
  } catch (error) {
    logLookupFailure('single', error);

    return { byFile: new Map(files.map((file) => [file.id, []])), union: [] };
  }

  return { byFile, union: unionInvoiceDuplicates([...byFile.values()]) };
};

/**
 * Em lote, para a lista e a planilha (até 10.000 linhas de nota): quais destas notas (linhas de arquivo NF) são possível
 * duplicada de uma NF de OUTRO envio. Duas consultas no total (mais uma para os rascunhos de nova versão), nunca uma por
 * linha: busca de uma vez as notas vivas que casam com qualquer chave ou arquivo do lote e cruza na memória.
 */
export const findDuplicateFileIds = async (files: DuplicateSearchFile[]): Promise<Set<string>> => {
  const duplicated = new Set<string>();
  const searchable = files.filter((file) => file.fileSha256 !== null || file.accessKeys.length > 0);
  const match = matchConditions(searchable);

  if (match.length === 0) {
    return duplicated;
  }

  const candidates = await prisma.revalleInvoiceFile.findMany({
    where: {
      kind: RevalleInvoiceFileKind.NF,
      OR: match,
      envelope: {
        ...liveSentEnvelope,
        revalleInvoice: { isInvoice: RevalleInvoiceStatus.YES, AND: [isNotSuperseded] },
      },
    },
    select: { id: true, envelopeId: true, accessKeys: true, fileSha256: true },
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

  // Uma nota de envio enviado e vivo aparece entre os candidatos (casa com ela mesma). Falta o rascunho de nova versão,
  // que também mostra o alerta (é a mesma regra da página) e não é "vivo e enviado".
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const unseenEnvelopeIds = [
    ...new Set(searchable.filter((file) => !candidateIds.has(file.id)).map((file) => file.envelopeId)),
  ];
  const draftIds = new Set(
    unseenEnvelopeIds.length === 0
      ? []
      : (
          await prisma.envelope.findMany({
            where: {
              id: { in: unseenEnvelopeIds },
              type: EnvelopeType.DOCUMENT,
              status: DocumentStatus.DRAFT,
              deletedAt: null,
              revalleInvoice: { isInvoice: RevalleInvoiceStatus.YES, AND: [isNotSuperseded] },
            },
            select: { id: true },
          })
        ).map((envelope) => envelope.id),
  );

  for (const file of searchable) {
    if (!candidateIds.has(file.id) && !draftIds.has(file.envelopeId)) {
      continue;
    }

    const sharing = [
      ...(file.fileSha256 === null ? [] : (byHash.get(file.fileSha256) ?? [])),
      ...file.accessKeys.flatMap((key) => byKey.get(key) ?? []),
    ];

    // Só outro envio: a mesma nota duas vezes no mesmo envio é outro aviso (o do diálogo).
    if (sharing.some((envelopeId) => envelopeId !== file.envelopeId)) {
      duplicated.add(file.id);
    }
  }

  return duplicated;
};

// Só o nome e o código do erro vão para o log: a mensagem do Prisma pode trazer os parâmetros da consulta (chaves, hash).
const logLookupFailure = (kind: 'single' | 'batch', error: unknown) => {
  logger.error({
    msg: 'revalle.invoice.duplicates.failed',
    kind,
    errorName: error instanceof Error ? error.name : 'unknown',
    errorCode:
      error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined,
  });
};

/**
 * `findInvoiceDuplicates` para as rotas que levam o resultado a uma tela: se a busca falhar, registra (sem dados) e
 * responde sem duplicadas, em vez de derrubar o pedido inteiro. O alerta é um aviso; nada depende dele.
 */
export const findInvoiceDuplicatesOrEmpty = async (
  row: Parameters<typeof findInvoiceDuplicates>[0],
): Promise<InvoiceDuplicate[]> => {
  try {
    return await findInvoiceDuplicates(row);
  } catch (error) {
    logLookupFailure('single', error);

    return [];
  }
};

/** `findDuplicateFileIds` para a lista e a planilha, com a mesma regra: falhou, registra (sem dados) e segue sem a marca. */
export const findDuplicateFileIdsOrEmpty = async (
  files: Parameters<typeof findDuplicateFileIds>[0],
): Promise<Set<string>> => {
  try {
    return await findDuplicateFileIds(files);
  } catch (error) {
    logLookupFailure('batch', error);

    return new Set();
  }
};
