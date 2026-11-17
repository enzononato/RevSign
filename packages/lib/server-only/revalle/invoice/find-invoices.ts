import { prisma } from '@documenso/prisma';
import {
  DocumentStatus,
  EnvelopeType,
  Prisma,
  type ReadStatus,
  RecipientRole,
  RevalleFinanceStatus,
  RevalleInvoiceFileKind,
  RevalleInvoiceStatus,
  RevalleSuggestionStatus,
  type SendStatus,
  SigningStatus,
} from '@prisma/client';

import { NEXT_PUBLIC_WEBAPP_URL } from '../../../constants/app';
import { type AccountingFilter, accountingStatusLabel } from '../../../revalle/accounting/accounting-status';
import {
  type FinanceFilter,
  financeStatusLabel,
  invoiceViewPath,
  NEW_VERSION_DRAFT_STATUSES,
} from '../../../revalle/finance/finance-status';
import { costCenterLabel, costCenterName } from '../../../revalle/invoice/cost-centers';
import { buildInvoiceExportCsv, type InvoiceExportRow } from '../../../revalle/invoice/export-csv';
import { type InvoiceDataSummary, toInvoiceDataSummary } from '../../../revalle/invoice/invoice-data';
import {
  fileFinanceStatus,
  type InvoicePosition,
  invoicePositions,
  invoiceRowTitle,
} from '../../../revalle/invoice/invoice-files';
import {
  INVOICE_DELETED_LABEL,
  INVOICE_LIST_STATUSES,
  INVOICE_STATUS_LABELS,
  type InvoiceRowStatus,
  invoiceDayRange,
  isOverInvoiceExportLimit,
  type TInvoiceFilters,
} from '../../../revalle/invoice/invoice-filters';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import { isAccountingMember } from '../accounting/members';
import { isFinanceMember } from '../finance/members';
import { findDuplicateFileIdsOrEmpty, sentAtOf } from './duplicates';

export type InvoiceViewer = { userId: number; isAdmin: boolean };

/** REVALLE (redesign v3): quem assina a NF, para os encaixes do cartão da lista (sem cópia nem visualizador). */
export type InvoiceListRecipient = {
  name: string;
  email: string;
  signingStatus: SigningStatus;
  role: RecipientRole;
  sendStatus: SendStatus; // REVALLE: estágio no tooltip dos encaixes (só leitura)
  readStatus: ReadStatus; // REVALLE:
};

/** Quem vê a lista, com as marcas do Financeiro e da Contabilidade lidas do banco uma vez por pedido. */
type ResolvedViewer = InvoiceViewer & { isFinance: boolean; isAccounting: boolean };

/**
 * Fase 9: uma linha por NOTA (linha de arquivo NF). O que é da nota: conta, sugestão, dados lidos, duplicada, quem aprovou,
 * centro e validação, e a situação no Financeiro (`fileFinanceStatus`). O que é do envio: `id`, `title`, `link`,
 * `recipients`, `version`, datas e remetente. Com uma nota, a linha é a de sempre (`position` 1 de 1).
 */
export type InvoiceListRow = {
  id: string;
  /** Fase 9: o arquivo da nota (a página da NF tem a âncora `#nota-{envelopeItemId}`). */
  envelopeItemId: string;
  /** Fase 9: o nome do arquivo da nota. */
  documentTitle: string;
  /** Fase 9: a posição da nota entre as notas do envio. */
  position: InvoicePosition;
  title: string;
  senderName: string;
  senderEmail: string;
  /** Data do envio; nula para o rascunho que está com o Financeiro (ainda não saiu). */
  sentAt: Date | null;
  completedAt: Date | null;
  status: InvoiceRowStatus;
  /** Excluído pelo remetente (só o admin vê). A versão substituída escondida pelo Financeiro não conta. */
  deleted: boolean;
  account: { code: string; name: string | null } | null;
  accountKind: 'PAYABLE' | 'RECEIVABLE' | null;
  suggestion: { code: string; confidence: string } | null;
  /** Fase 8: fornecedor, número e valor lidos da NF pela IA (podem estar errados); nulo quando os três estão vazios. */
  invoiceData: InvoiceDataSummary | null;
  /**
   * Fase 8: outra NF viva tem uma chave em comum ou o mesmo arquivo. Só é calculado para o Financeiro, a Contabilidade e
   * o admin; para os demais é sempre `false` (a consulta nem roda).
   */
  isPossibleDuplicate: boolean;
  acceptedSuggestion: boolean | null;
  /** Fase 6: situação no Financeiro, versão (1, 2…) e quem do Financeiro aprovou (ou definiu) a conta. */
  financeStatus: RevalleFinanceStatus | null;
  version: number;
  approvedBy: string | null;
  /** Fase 7: centro de custo ("101 – Puxada"), a validação da Contabilidade e quem validou (nome congelado). */
  costCenterCode: string | null;
  costCenterLabel: string | null;
  costCenterValidatedAt: Date | null;
  costCenterValidatedBy: string | null;
  /**
   * Caminho do documento para quem vê: o Financeiro, a Contabilidade e quem assina abrem a página da NF (só leitura);
   * o dono abre no time e o admin no painel.
   */
  link: string | null;
  /** REVALLE (redesign v3): na ordem de assinatura (depois pelo id). */
  recipients: InvoiceListRecipient[];
};

export type FindInvoicesOptions = InvoiceViewer & {
  filters: TInvoiceFilters;
  page?: number;
  perPage?: number;
};

const SENT = DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SENT;

/** Status do envelope em que a NF ainda pode ser aprovada (enviada ou concluída). */
const APPROVABLE_STATUSES = [DocumentStatus.PENDING, DocumentStatus.COMPLETED];

/**
 * Versão pendente substituída pelo Financeiro: o upstream a esconde (excluída sem aviso), mas na página "Notas fiscais"
 * ela continua visível, como "Substituída", para o dono, os destinatários e o Financeiro.
 */
const supersededHiddenVersion = {
  revalleInvoice: { financeStatus: RevalleFinanceStatus.SUPERSEDED },
  status: { not: DocumentStatus.COMPLETED },
} satisfies Prisma.EnvelopeWhereInput;

/**
 * Rascunho de uma nova versão cujo envio falhou (`isNewVersionDraftRow`): ninguém assinou nem recebeu o convite, o link
 * antigo já está bloqueado e a NF só sai dali quando o Financeiro ou a Contabilidade usa "Enviar de novo". Sem este ramo,
 * ela ficaria fora das filas e dos contadores, e a nota pararia em silêncio (não há e-mail de fluxo).
 */
const newVersionDraftWhere = {
  status: DocumentStatus.DRAFT,
  revalleInvoice: {
    previousEnvelopeId: { not: null },
    financeStatus: { in: [...NEW_VERSION_DRAFT_STATUSES] },
  },
} satisfies Prisma.EnvelopeWhereInput;

/** NF enviada (ou concluída) cuja conta ainda não foi aprovada. Não inclui a excluída pelo remetente. */
const awaitingApprovalWhere = {
  revalleInvoice: { financeStatus: RevalleFinanceStatus.PENDING_APPROVAL },
  status: { in: APPROVABLE_STATUSES },
  deletedAt: null,
} satisfies Prisma.EnvelopeWhereInput;

/** Linha de arquivo que é nota fiscal (a lista, as filas e os contadores contam notas). */
const nfFile = { kind: RevalleInvoiceFileKind.NF } satisfies Prisma.RevalleInvoiceFileWhereInput;

/** A nota ainda sem a aprovação dela, num envio enviado (ou concluído) que aguarda o Financeiro. */
const awaitingApprovalFileWhere = {
  approvedAt: null,
  envelope: awaitingApprovalWhere,
} satisfies Prisma.RevalleInvoiceFileWhereInput;

/**
 * "Aguardando o Financeiro", por nota: a aprovação da nota ainda não foi dada num envio que aguarda, ou a nova versão
 * ficou em rascunho e espera o "Enviar de novo" (todas as notas dela). A fila do Financeiro e o contador do menu leem este
 * filtro. A NF excluída pelo remetente não espera ninguém (`approve` responde 404 nela), nem para o admin que também é do
 * Financeiro.
 */
export const financePendingFileWhere = {
  ...nfFile,
  envelope: { deletedAt: null },
  OR: [awaitingApprovalFileWhere, { envelope: newVersionDraftWhere }],
} satisfies Prisma.RevalleInvoiceFileWhereInput;

/**
 * "Aguardando a Contabilidade", por nota: a nota sem a validação do centro, num envio ainda válido (não substituído),
 * enviado ou concluído, sem recusa e não excluído, ou a nova versão que ficou em rascunho (a Contabilidade também a envia
 * de novo, mesmo já validada pela correção). Nota sem centro de custo também espera (a Contabilidade define o primeiro
 * centro). A fila da Contabilidade, o contador do menu e o aviso do admin leem este filtro.
 */
export const accountingPendingFileWhere = {
  ...nfFile,
  envelope: { deletedAt: null },
  OR: [
    {
      costCenterValidatedAt: null,
      envelope: {
        revalleInvoice: { OR: [{ financeStatus: null }, { financeStatus: { not: RevalleFinanceStatus.SUPERSEDED } }] },
        status: { in: APPROVABLE_STATUSES },
        recipients: { none: { signingStatus: SigningStatus.REJECTED } },
      },
    },
    { envelope: newVersionDraftWhere },
  ],
} satisfies Prisma.RevalleInvoiceFileWhereInput;

const accountingFilterWhere = (filter: AccountingFilter | undefined): Prisma.RevalleInvoiceFileWhereInput | null => {
  switch (filter) {
    case 'pendentes':
      return accountingPendingFileWhere;
    case 'validadas':
      return { costCenterValidatedAt: { not: null } };
    default:
      return null;
  }
};

/** Por nota: a situação de cada nota é a do envio, salvo a nota já aprovada num envio que aguarda (`fileFinanceStatus`). */
const financeFilterWhere = (filter: FinanceFilter | undefined): Prisma.RevalleInvoiceFileWhereInput | null => {
  const stateIs = (financeStatus: RevalleFinanceStatus) => ({ envelope: { revalleInvoice: { financeStatus } } });

  switch (filter) {
    case 'pendentes':
      return financePendingFileWhere;
    case 'aguardando-aprovacao':
      return awaitingApprovalFileWhere;
    case 'aprovadas':
      return {
        OR: [
          stateIs(RevalleFinanceStatus.APPROVED),
          { approvedAt: { not: null }, ...stateIs(RevalleFinanceStatus.PENDING_APPROVAL) },
        ],
      };
    case 'substituidas':
      return stateIs(RevalleFinanceStatus.SUPERSEDED);
    case 'antigas':
      return stateIs(RevalleFinanceStatus.LEGACY);
    default:
      return null;
  }
};

/**
 * Visibilidade igual à do documento no RevSign (só organizações pessoais): o dono, quem é destinatário pelo e-mail (sem
 * ter escondido o documento) e o admin, que vê todas. Fase 6: quem é do Financeiro também vê todas (conferido no banco
 * a cada pedido: desmarcado, deixa de ver na hora); Fase 7: a Contabilidade também. NF excluída pelo remetente some
 * para o dono, para os destinatários, para o Financeiro e para a Contabilidade, mas o admin continua vendo (a
 * contabilidade pode já ter lançado).
 *
 * Fase 6, além das NFs enviadas:
 * - o rascunho de uma nova versão, com o envio parado (`isNewVersionDraftRow`), para o Financeiro, a Contabilidade e o dono
 *   (quem assina ainda não recebeu nada); o rascunho comum nunca aparece;
 * - a versão pendente substituída (escondida pelo upstream), para o dono, os destinatários, o Financeiro e a
 *   Contabilidade.
 *
 * Fase 9: o filtro é das NOTAS (linhas de arquivo NF): a visibilidade, a situação do envio e o período ficam em
 * `envelope`; a conta, as filas do Financeiro e da Contabilidade e a validação, na nota.
 */
const buildInvoiceFileWhere = async ({
  userId,
  isAdmin,
  isFinance,
  isAccounting,
  filters,
}: ResolvedViewer & { filters: TInvoiceFilters }) => {
  const conditions: Prisma.EnvelopeWhereInput[] = [];

  if (!isAdmin && !isFinance && !isAccounting) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
    const isRecipient = { email: { equals: user.email, mode: Prisma.QueryMode.insensitive } };

    conditions.push({
      OR: [
        { userId },
        {
          status: { not: DocumentStatus.DRAFT },
          recipients: { some: { ...isRecipient, documentDeletedAt: null } },
        },
        { ...supersededHiddenVersion, recipients: { some: isRecipient } },
      ],
    });
  }

  if (!isAdmin) {
    conditions.push({ OR: [{ deletedAt: null }, supersededHiddenVersion] });
  }

  conditions.push(
    filters.status
      ? { status: filters.status }
      : {
          OR: [{ status: { in: [...INVOICE_LIST_STATUSES] } }, newVersionDraftWhere],
        },
  );

  const range = invoiceDayRange(filters);

  // Data de envio = evento DOCUMENT_SENT. Documento concluído direto no envio (ninguém para assinar) não tem o evento:
  // vale a data de criação, a mesma que a tela mostra (o rascunho com o Financeiro também).
  if (range) {
    conditions.push({
      OR: [
        { auditLogs: { some: { type: SENT, createdAt: range } } },
        { auditLogs: { none: { type: SENT } }, createdAt: range },
      ],
    });
  }

  const fileConditions = [financeFilterWhere(filters.finance), accountingFilterWhere(filters.accounting)].filter(
    (condition): condition is Prisma.RevalleInvoiceFileWhereInput => condition !== null,
  );

  return {
    ...nfFile,
    ...(filters.accountCode ? { choiceCode: filters.accountCode } : {}),
    envelope: {
      type: EnvelopeType.DOCUMENT,
      revalleInvoice: { isInvoice: RevalleInvoiceStatus.YES },
      AND: conditions,
    },
    AND: fileConditions,
  } satisfies Prisma.RevalleInvoiceFileWhereInput;
};

/** O que é do envio, para as linhas das notas dele. */
const envelopeSelect = {
  id: true,
  title: true,
  status: true,
  createdAt: true,
  completedAt: true,
  deletedAt: true,
  userId: true,
  user: { select: { name: true, email: true } },
  team: { select: { url: true } },
  auditLogs: { where: { type: SENT }, orderBy: { createdAt: 'asc' }, take: 1, select: { createdAt: true } },
  // REVALLE (redesign v3): só leitura, para os encaixes; cópia e visualizador não assinam.
  recipients: {
    where: { role: { notIn: [RecipientRole.CC, RecipientRole.VIEWER] } },
    orderBy: [{ signingOrder: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
    select: { name: true, email: true, signingStatus: true, role: true, sendStatus: true, readStatus: true }, // REVALLE: estágio no tooltip
  },
  revalleInvoice: { select: { financeStatus: true, version: true } },
  // Fase 9: as notas do envio, para a posição de cada uma (1 de 3...).
  revalleInvoiceFiles: {
    where: nfFile,
    select: { id: true, kind: true, envelopeItem: { select: { order: true } } },
  },
} satisfies Prisma.EnvelopeSelect;

/** O que é da nota. */
const fileSelect = {
  id: true,
  envelopeId: true,
  envelopeItemId: true,
  envelopeItem: { select: { title: true } },
  choiceCode: true,
  acceptedSuggestion: true,
  suggestionStatus: true,
  suggestion: true,
  supplierName: true,
  invoiceNumber: true,
  totalAmountCents: true,
  accessKeys: true,
  fileSha256: true,
  approvedAt: true,
  approvedById: true,
  costCenterCode: true,
  costCenterValidatedAt: true,
  costCenterValidatedById: true,
  costCenterValidatedByName: true,
} satisfies Prisma.RevalleInvoiceFileSelect;

type SelectedEnvelope = Prisma.EnvelopeGetPayload<{ select: typeof envelopeSelect }>;
type SelectedFile = Prisma.RevalleInvoiceFileGetPayload<{ select: typeof fileSelect }>;
type SelectedNote = { file: SelectedFile; envelope: SelectedEnvelope };

const readSuggestion = (file: SelectedFile) => {
  const stored = file.suggestion;

  if (file.suggestionStatus !== RevalleSuggestionStatus.DONE || !stored || typeof stored !== 'object') {
    return null;
  }

  const { accountCode, confidence } = stored as Record<string, unknown>;

  return typeof accountCode === 'string' && typeof confidence === 'string' ? { code: accountCode, confidence } : null;
};

/** A linha da lista com as chaves de acesso, que só a planilha usa (a lista não as mostra). */
type InvoiceRowWithKeys = InvoiceListRow & { accessKeys: string[] };

const positionsOf = (envelope: SelectedEnvelope) =>
  invoicePositions(
    envelope.revalleInvoiceFiles.map((file) => ({ id: file.id, kind: file.kind, order: file.envelopeItem.order })),
  );

const toRows = async (notes: SelectedNote[], viewer: ResolvedViewer): Promise<InvoiceRowWithKeys[]> => {
  const codes = [...new Set(notes.flatMap(({ file }) => (file.choiceCode ? [file.choiceCode] : [])))];
  // Quem aprovou e, desde a Fase 7, quem validou o centro (o nome congelado vale; o atual só quando ele ficou vazio).
  const approverIds = [
    ...new Set(
      notes.flatMap(({ file }) => [
        ...(file.approvedById ? [file.approvedById] : []),
        ...(file.costCenterValidatedById ? [file.costCenterValidatedById] : []),
      ]),
    ),
  ];

  // Inclusive contas inativas: NF antiga continua mostrando número e nome.
  const accounts = new Map(
    codes.length > 0
      ? (
          await prisma.revalleAccountingAccount.findMany({
            where: { code: { in: codes } },
            select: { code: true, name: true, kind: true },
          })
        ).map((account) => [account.code, account])
      : [],
  );

  // O nome (o e-mail quando não tem nome). Sem FK: usuário apagado fica sem nome.
  const approvers = new Map(
    approverIds.length > 0
      ? (
          await prisma.user.findMany({
            where: { id: { in: approverIds } },
            select: { id: true, name: true, email: true },
          })
        ).map((user) => [user.id, user.name?.trim() || user.email])
      : [],
  );

  // Fase 8: a marca "Possível duplicada" é de quem decide sobre a nota; para os outros nem se consulta. Fase 9: por nota.
  const duplicateIds =
    viewer.isFinance || viewer.isAccounting || viewer.isAdmin
      ? await findDuplicateFileIdsOrEmpty(
          notes.map(({ file }) => ({
            id: file.id,
            envelopeId: file.envelopeId,
            accessKeys: file.accessKeys,
            fileSha256: file.fileSha256,
          })),
        )
      : new Set<string>();

  const positions = new Map<string, Map<string, InvoicePosition>>();

  return notes.map(({ file, envelope }) => {
    const code = file.choiceCode;
    const account = code ? accounts.get(code) : undefined;
    const envelopeFinanceStatus = envelope.revalleInvoice?.financeStatus ?? null;
    const isDraft = envelope.status === DocumentStatus.DRAFT;

    if (!positions.has(envelope.id)) {
      positions.set(envelope.id, positionsOf(envelope));
    }

    const position = positions.get(envelope.id)?.get(file.id) ?? { index: 1, total: 1 };

    const hiddenSuperseded =
      envelopeFinanceStatus === RevalleFinanceStatus.SUPERSEDED && envelope.status !== DocumentStatus.COMPLETED;
    const deleted = envelope.deletedAt !== null && !hiddenSuperseded;

    // Financeiro e Contabilidade: sempre a página da NF (é lá que ficam as ações deles). Dono: a página do documento no
    // time, enquanto ela existir. Admin: o painel. Os demais (quem assina): a página da NF.
    const link =
      viewer.isFinance || viewer.isAccounting
        ? invoiceViewPath(envelope.id)
        : envelope.userId === viewer.userId && envelope.deletedAt === null
          ? `/t/${envelope.team.url}/documents/${envelope.id}`
          : viewer.isAdmin
            ? `/admin/documents/${envelope.id}`
            : invoiceViewPath(envelope.id);

    return {
      id: envelope.id,
      envelopeItemId: file.envelopeItemId,
      documentTitle: file.envelopeItem.title,
      position,
      title: envelope.title,
      senderName: envelope.user.name?.trim() || envelope.user.email,
      senderEmail: envelope.user.email,
      sentAt: isDraft ? null : sentAtOf(envelope),
      completedAt: envelope.completedAt,
      status: envelope.status as InvoiceRowStatus,
      deleted,
      account: code ? { code, name: account?.name ?? null } : null,
      accountKind: account?.kind ?? null,
      suggestion: readSuggestion(file),
      invoiceData: toInvoiceDataSummary(file),
      isPossibleDuplicate: duplicateIds.has(file.id),
      accessKeys: file.accessKeys,
      acceptedSuggestion: file.acceptedSuggestion,
      financeStatus: fileFinanceStatus(envelopeFinanceStatus, file.approvedAt),
      version: envelope.revalleInvoice?.version ?? 1,
      approvedBy: file.approvedById ? (approvers.get(file.approvedById) ?? null) : null,
      costCenterCode: file.costCenterCode,
      costCenterLabel: file.costCenterCode ? costCenterLabel(file.costCenterCode) : null,
      costCenterValidatedAt: file.costCenterValidatedAt,
      costCenterValidatedBy: file.costCenterValidatedAt
        ? (file.costCenterValidatedByName ??
          (file.costCenterValidatedById ? (approvers.get(file.costCenterValidatedById) ?? null) : null))
        : null,
      link,
      recipients: envelope.recipients, // REVALLE (redesign v3)
    };
  });
};

/**
 * Fase 9: os ids das notas que passam no filtro, na ordem da coluna "Enviado em" (mais recente primeiro; empate pelo id do
 * envio) e, dentro do envio, na ordem dos arquivos. A ordem, o corte da página e a contagem ficam no banco: aqui só
 * passam os ids (o Prisma não ordena pelo primeiro evento DOCUMENT_SENT). Data de envio = o primeiro DOCUMENT_SENT; sem
 * ele (concluído direto no envio, ou o rascunho com o Financeiro), a criação, a mesma que a tela mostra.
 *
 * Limite conhecido (aceito para o volume da Revalle): o filtro de período (`auditLogs.some`) não tem índice em
 * `DocumentAuditLog` por tipo e data. Planejado (Fase 5.1): gravar `sentAt` na linha do envio e indexar.
 */
const findOrderedFileIds = async (
  where: Prisma.RevalleInvoiceFileWhereInput,
  page?: { skip: number; take: number },
): Promise<{ ids: string[]; count: number }> => {
  const matching = (await prisma.revalleInvoiceFile.findMany({ where, select: { id: true } })).map((row) => row.id);

  if (matching.length === 0) {
    return { ids: [], count: 0 };
  }

  const slice = page ? Prisma.sql`LIMIT ${page.take} OFFSET ${page.skip}` : Prisma.empty;
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT f.id
    FROM "RevalleInvoiceFile" f
    JOIN "Envelope" e ON e.id = f."envelopeId"
    JOIN "EnvelopeItem" i ON i.id = f."envelopeItemId"
    WHERE f.id = ANY(${matching})
    ORDER BY
      COALESCE(
        (SELECT MIN(l."createdAt") FROM "DocumentAuditLog" l WHERE l."envelopeId" = e.id AND l.type = ${SENT}),
        e."createdAt"
      ) DESC,
      e.id COLLATE "C" DESC,
      i."order" ASC,
      f.id COLLATE "C" ASC
    ${slice}`;

  return { ids: rows.map((row) => row.id), count: matching.length };
};

const findRowsInOrder = async (fileIds: string[], viewer: ResolvedViewer) => {
  if (fileIds.length === 0) {
    return [];
  }

  const files = await prisma.revalleInvoiceFile.findMany({ where: { id: { in: fileIds } }, select: fileSelect });
  const envelopeIds = [...new Set(files.map((file) => file.envelopeId))];
  const envelopes = new Map(
    (await prisma.envelope.findMany({ where: { id: { in: envelopeIds } }, select: envelopeSelect })).map((envelope) => [
      envelope.id,
      envelope,
    ]),
  );
  const order = new Map(fileIds.map((id, index) => [id, index]));

  const notes = files
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .flatMap((file) => {
      const envelope = envelopes.get(file.envelopeId);

      return envelope ? [{ file, envelope }] : [];
    });

  return await toRows(notes, viewer);
};

/** A lista não leva as chaves de acesso. */
const withoutKeys = ({ accessKeys: _accessKeys, ...row }: InvoiceRowWithKeys): InvoiceListRow => row;

const resolveViewer = async ({ userId, isAdmin }: InvoiceViewer): Promise<ResolvedViewer> => {
  const [isFinance, isAccounting] = await Promise.all([isFinanceMember(userId), isAccountingMember(userId)]);

  return { userId, isAdmin, isFinance, isAccounting };
};

/** Fase 9: uma linha por nota; a página e a contagem são de notas. */
export const findInvoices = async ({ userId, isAdmin, filters, page = 1, perPage = 20 }: FindInvoicesOptions) => {
  const viewer = await resolveViewer({ userId, isAdmin });
  const { ids, count } = await findOrderedFileIds(await buildInvoiceFileWhere({ ...viewer, filters }), {
    skip: (page - 1) * perPage,
    take: perPage,
  });

  return {
    data: (await findRowsInOrder(ids, viewer)).map(withoutKeys),
    count,
    currentPage: page,
    perPage,
    totalPages: Math.max(1, Math.ceil(count / perPage)),
  };
};

/**
 * Planilha com os mesmos filtros e a mesma visibilidade da página, uma linha por nota (o cabeçalho não muda: com 2+ notas
 * o `titulo` ganha "· nota 2 de 3"; `id` e `link` são do envio). Acima do limite (10.000 notas), nada é montado.
 */
export const exportInvoicesCsv = async ({
  userId,
  isAdmin,
  filters,
}: InvoiceViewer & { filters: TInvoiceFilters }): Promise<{ tooMany: true } | { tooMany: false; csv: string }> => {
  const viewer = await resolveViewer({ userId, isAdmin });
  const where = await buildInvoiceFileWhere({ ...viewer, filters });

  if (isOverInvoiceExportLimit(await prisma.revalleInvoiceFile.count({ where }))) {
    return { tooMany: true };
  }

  const baseUrl = NEXT_PUBLIC_WEBAPP_URL().replace(/\/$/, '');

  const rows: InvoiceExportRow[] = (await findRowsInOrder((await findOrderedFileIds(where)).ids, viewer)).map(
    (row) => ({
      id: row.id,
      title: invoiceRowTitle(row.title, row.position),
      senderName: row.senderName,
      sentAt: row.sentAt,
      completedAt: row.completedAt,
      status: row.deleted ? INVOICE_DELETED_LABEL : INVOICE_STATUS_LABELS[row.status],
      choice: row.account?.code ?? null,
      accountName: row.account?.name ?? null,
      accountKind: row.accountKind,
      suggestedCode: row.suggestion?.code ?? null,
      confidence: row.suggestion?.confidence ?? null,
      acceptedSuggestion: row.acceptedSuggestion,
      link: row.link ? `${baseUrl}${row.link}` : '',
      financeStatus: financeStatusLabel(row.financeStatus, row.status),
      approvedBy: row.approvedBy,
      costCenterCode: row.costCenterCode,
      costCenterName: row.costCenterCode ? costCenterName(row.costCenterCode) : null,
      accountingStatus: accountingStatusLabel(row),
      validatedBy: row.costCenterValidatedBy,
      supplierName: row.invoiceData?.supplierName ?? null,
      invoiceNumber: row.invoiceData?.invoiceNumber ?? null,
      totalAmountCents: row.invoiceData?.totalAmountCents ?? null,
      accessKeys: row.accessKeys,
      isPossibleDuplicate: row.isPossibleDuplicate,
    }),
  );

  return { tooMany: false, csv: buildInvoiceExportCsv(rows) };
};
