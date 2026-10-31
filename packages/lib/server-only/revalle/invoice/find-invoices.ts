import { prisma } from '@documenso/prisma';
import {
  DocumentStatus,
  EnvelopeType,
  Prisma,
  RevalleFinanceStatus,
  RevalleInvoiceStatus,
  RevalleSuggestionStatus,
} from '@prisma/client';

import { NEXT_PUBLIC_WEBAPP_URL } from '../../../constants/app';
import { type FinanceFilter, financeStatusLabel, invoiceViewPath } from '../../../revalle/finance/finance-status';
import {
  buildInvoiceExportCsv,
  INVOICE_DEFER_CHOICE,
  type InvoiceExportRow,
} from '../../../revalle/invoice/export-csv';
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
import { isFinanceMember } from '../finance/members';

export type InvoiceViewer = { userId: number; isAdmin: boolean };

/** Quem vê a lista, com a marca do Financeiro lida do banco uma vez por pedido. */
type ResolvedViewer = InvoiceViewer & { isFinance: boolean };

export type InvoiceListRow = {
  id: string;
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
  deferred: boolean;
  suggestion: { code: string; confidence: string } | null;
  acceptedSuggestion: boolean | null;
  /** Fase 6: situação no Financeiro, versão (1, 2…) e quem do Financeiro aprovou (ou definiu) a conta. */
  financeStatus: RevalleFinanceStatus | null;
  version: number;
  approvedBy: string | null;
  /**
   * Caminho do documento para quem vê: o Financeiro e quem assina abrem a página da NF (só leitura); o dono abre no
   * time e o admin no painel.
   */
  link: string | null;
};

export type FindInvoicesOptions = InvoiceViewer & {
  filters: TInvoiceFilters;
  page?: number;
  perPage?: number;
};

const SENT = DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SENT;

/** Rascunho que está com o Financeiro: retido ("Deixar para o Financeiro") ou aprovado com o envio ainda não saído. */
const FINANCE_DRAFT_STATUSES = [RevalleFinanceStatus.AWAITING_ACCOUNT, RevalleFinanceStatus.APPROVED];

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

const financeFilterWhere = (filter: FinanceFilter | undefined): Prisma.EnvelopeWhereInput | null => {
  const stateIs = (financeStatus: RevalleFinanceStatus) => ({ revalleInvoice: { financeStatus } });

  switch (filter) {
    case 'pendentes':
      return {
        OR: [
          stateIs(RevalleFinanceStatus.AWAITING_ACCOUNT),
          { ...stateIs(RevalleFinanceStatus.PENDING_APPROVAL), status: { in: APPROVABLE_STATUSES } },
        ],
      };
    case 'aguardando-conta':
      return stateIs(RevalleFinanceStatus.AWAITING_ACCOUNT);
    case 'aguardando-aprovacao':
      return { ...stateIs(RevalleFinanceStatus.PENDING_APPROVAL), status: { in: APPROVABLE_STATUSES } };
    case 'aprovadas':
      return stateIs(RevalleFinanceStatus.APPROVED);
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
 * a cada pedido: desmarcado, deixa de ver na hora). NF excluída pelo remetente some para o dono, para os destinatários
 * e para o Financeiro, mas o admin continua vendo (a contabilidade pode já ter lançado).
 *
 * Fase 6, além das NFs enviadas:
 * - o rascunho que está com o Financeiro (retido ou aprovado e ainda não enviado), para o Financeiro e o dono (quem
 *   assina ainda não recebeu nada);
 * - a versão pendente substituída pelo Financeiro (escondida pelo upstream), para o dono, os destinatários e o
 *   Financeiro.
 */
const buildInvoiceWhere = async ({
  userId,
  isAdmin,
  isFinance,
  filters,
}: ResolvedViewer & { filters: TInvoiceFilters }) => {
  const conditions: Prisma.EnvelopeWhereInput[] = [];

  if (!isAdmin && !isFinance) {
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
          OR: [
            { status: { in: [...INVOICE_LIST_STATUSES] } },
            {
              status: DocumentStatus.DRAFT,
              revalleInvoice: { financeStatus: { in: FINANCE_DRAFT_STATUSES } },
            },
          ],
        },
  );

  const financeCondition = financeFilterWhere(filters.finance);

  if (financeCondition) {
    conditions.push(financeCondition);
  }

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

  return {
    type: EnvelopeType.DOCUMENT,
    revalleInvoice: {
      isInvoice: RevalleInvoiceStatus.YES,
      ...(filters.accountCode ? { choiceCode: filters.accountCode, choiceDefer: false } : {}),
      ...(filters.deferred ? { choiceDefer: true } : {}),
    },
    AND: conditions,
  } satisfies Prisma.EnvelopeWhereInput;
};

const select = {
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
  revalleInvoice: {
    select: {
      choiceCode: true,
      choiceDefer: true,
      acceptedSuggestion: true,
      suggestionStatus: true,
      suggestion: true,
      financeStatus: true,
      approvedById: true,
      version: true,
    },
  },
} satisfies Prisma.EnvelopeSelect;

type SelectedEnvelope = Prisma.EnvelopeGetPayload<{ select: typeof select }>;

const readSuggestion = (invoice: SelectedEnvelope['revalleInvoice']) => {
  const stored = invoice?.suggestion;

  if (invoice?.suggestionStatus !== RevalleSuggestionStatus.DONE || !stored || typeof stored !== 'object') {
    return null;
  }

  const { accountCode, confidence } = stored as Record<string, unknown>;

  return typeof accountCode === 'string' && typeof confidence === 'string' ? { code: accountCode, confidence } : null;
};

const toRows = async (envelopes: SelectedEnvelope[], viewer: ResolvedViewer): Promise<InvoiceListRow[]> => {
  const codes = [
    ...new Set(envelopes.flatMap((e) => (e.revalleInvoice?.choiceCode ? [e.revalleInvoice.choiceCode] : []))),
  ];
  const approverIds = [
    ...new Set(envelopes.flatMap((e) => (e.revalleInvoice?.approvedById ? [e.revalleInvoice.approvedById] : []))),
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

  // Quem aprovou: o nome (o e-mail quando não tem nome). Sem FK: usuário apagado fica sem nome.
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

  return envelopes.map((envelope) => {
    const invoice = envelope.revalleInvoice;
    const deferred = invoice?.choiceDefer ?? false;
    const code = deferred ? null : (invoice?.choiceCode ?? null);
    const account = code ? accounts.get(code) : undefined;
    const financeStatus = invoice?.financeStatus ?? null;
    const isDraft = envelope.status === DocumentStatus.DRAFT;

    const hiddenSuperseded =
      financeStatus === RevalleFinanceStatus.SUPERSEDED && envelope.status !== DocumentStatus.COMPLETED;
    const deleted = envelope.deletedAt !== null && !hiddenSuperseded;

    // Financeiro: sempre a página da NF (é lá que ficam as ações dele). Dono: a página do documento no time, enquanto
    // ela existir. Admin: o painel. Os demais (quem assina): a página da NF.
    const link = viewer.isFinance
      ? invoiceViewPath(envelope.id)
      : envelope.userId === viewer.userId && envelope.deletedAt === null
        ? `/t/${envelope.team.url}/documents/${envelope.id}`
        : viewer.isAdmin
          ? `/admin/documents/${envelope.id}`
          : invoiceViewPath(envelope.id);

    return {
      id: envelope.id,
      title: envelope.title,
      senderName: envelope.user.name?.trim() || envelope.user.email,
      senderEmail: envelope.user.email,
      sentAt: isDraft ? null : sentAtOf(envelope),
      completedAt: envelope.completedAt,
      status: envelope.status as InvoiceRowStatus,
      deleted,
      account: code ? { code, name: account?.name ?? null } : null,
      accountKind: account?.kind ?? null,
      deferred,
      suggestion: readSuggestion(invoice),
      acceptedSuggestion: invoice?.acceptedSuggestion ?? null,
      financeStatus,
      version: invoice?.version ?? 1,
      approvedBy: invoice?.approvedById ? (approvers.get(invoice.approvedById) ?? null) : null,
      link,
    };
  });
};

const sentAtOf = (envelope: { createdAt: Date; auditLogs: { createdAt: Date }[] }) =>
  envelope.auditLogs[0]?.createdAt ?? envelope.createdAt;

/**
 * Ids na ordem da coluna "Enviado em" (mais recente primeiro; empate pelo id). O Prisma não ordena pelo primeiro evento
 * DOCUMENT_SENT, então a ordem é feita aqui sobre os ids e datas (a planilha já é limitada a 10.000 linhas).
 *
 * Limite conhecido (aceito para o volume da Revalle): cada página carrega TODOS os ids que passam no filtro, com o
 * primeiro DOCUMENT_SENT de cada, e o filtro de período (`auditLogs.some`) não tem índice em `DocumentAuditLog`.
 * Planejado (Fase 5.1): gravar `sentAt` na linha da classificação no envio, indexar `(isInvoice, sentAt)` e
 * ordenar/paginar no SQL.
 */
const findOrderedIds = async (where: Prisma.EnvelopeWhereInput) => {
  const envelopes = await prisma.envelope.findMany({
    where,
    select: { id: true, createdAt: true, auditLogs: select.auditLogs },
  });

  return envelopes
    .map((envelope) => ({ id: envelope.id, sentAt: sentAtOf(envelope).getTime() }))
    .sort((a, b) => b.sentAt - a.sentAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .map((envelope) => envelope.id);
};

const findRowsInOrder = async (ids: string[], viewer: ResolvedViewer) => {
  if (ids.length === 0) {
    return [];
  }

  const envelopes = await prisma.envelope.findMany({ where: { id: { in: ids } }, select });
  const position = new Map(ids.map((id, index) => [id, index]));

  envelopes.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));

  return await toRows(envelopes, viewer);
};

const resolveViewer = async ({ userId, isAdmin }: InvoiceViewer): Promise<ResolvedViewer> => ({
  userId,
  isAdmin,
  isFinance: await isFinanceMember(userId),
});

export const findInvoices = async ({ userId, isAdmin, filters, page = 1, perPage = 20 }: FindInvoicesOptions) => {
  const viewer = await resolveViewer({ userId, isAdmin });
  const ids = await findOrderedIds(await buildInvoiceWhere({ ...viewer, filters }));
  const count = ids.length;

  return {
    data: await findRowsInOrder(ids.slice((page - 1) * perPage, page * perPage), viewer),
    count,
    currentPage: page,
    perPage,
    totalPages: Math.max(1, Math.ceil(count / perPage)),
  };
};

/** Planilha com os mesmos filtros e a mesma visibilidade da página. Acima do limite, nada é montado. */
export const exportInvoicesCsv = async ({
  userId,
  isAdmin,
  filters,
}: InvoiceViewer & { filters: TInvoiceFilters }): Promise<{ tooMany: true } | { tooMany: false; csv: string }> => {
  const viewer = await resolveViewer({ userId, isAdmin });
  const where = await buildInvoiceWhere({ ...viewer, filters });

  if (isOverInvoiceExportLimit(await prisma.envelope.count({ where }))) {
    return { tooMany: true };
  }

  const baseUrl = NEXT_PUBLIC_WEBAPP_URL().replace(/\/$/, '');

  const rows: InvoiceExportRow[] = (await findRowsInOrder(await findOrderedIds(where), viewer)).map((row) => ({
    id: row.id,
    title: row.title,
    senderName: row.senderName,
    sentAt: row.sentAt,
    completedAt: row.completedAt,
    status: row.deleted ? INVOICE_DELETED_LABEL : INVOICE_STATUS_LABELS[row.status],
    choice: row.deferred ? INVOICE_DEFER_CHOICE : (row.account?.code ?? null),
    accountName: row.account?.name ?? null,
    accountKind: row.accountKind,
    suggestedCode: row.suggestion?.code ?? null,
    confidence: row.suggestion?.confidence ?? null,
    acceptedSuggestion: row.acceptedSuggestion,
    link: row.link ? `${baseUrl}${row.link}` : '',
    financeStatus: financeStatusLabel(row.financeStatus, row.status),
    approvedBy: row.approvedBy,
  }));

  return { tooMany: false, csv: buildInvoiceExportCsv(rows) };
};
