import { prisma } from '@documenso/prisma';
import type { DocumentStatus } from '@prisma/client';
import { EnvelopeType, Prisma, RevalleInvoiceStatus, RevalleSuggestionStatus } from '@prisma/client';

import { NEXT_PUBLIC_WEBAPP_URL } from '../../../constants/app';
import {
  buildInvoiceExportCsv,
  INVOICE_DEFER_CHOICE,
  type InvoiceExportRow,
} from '../../../revalle/invoice/export-csv';
import {
  INVOICE_EXPORT_LIMIT,
  INVOICE_LIST_STATUSES,
  INVOICE_STATUS_LABELS,
  type InvoiceListStatus,
  invoiceDayRange,
  type TInvoiceFilters,
} from '../../../revalle/invoice/invoice-filters';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';

export type InvoiceViewer = { userId: number; isAdmin: boolean };

export type InvoiceListRow = {
  id: string;
  title: string;
  senderName: string;
  senderEmail: string;
  sentAt: Date;
  completedAt: Date | null;
  status: InvoiceListStatus;
  account: { code: string; name: string | null } | null;
  accountKind: 'PAYABLE' | 'RECEIVABLE' | null;
  deferred: boolean;
  suggestion: { code: string; confidence: string } | null;
  acceptedSuggestion: boolean | null;
  /** Caminho do documento para quem está vendo: o dono abre no time, o admin no painel; signatário não tem link. */
  link: string | null;
};

export type FindInvoicesOptions = InvoiceViewer & {
  filters: TInvoiceFilters;
  page?: number;
  perPage?: number;
};

const SENT = DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SENT;

/**
 * Visibilidade igual à do documento no RevSign (só organizações pessoais): o dono, quem é destinatário pelo e-mail (sem
 * ter escondido o documento) e o admin, que vê todas. Só NF já enviada (rascunho não entra) e não apagada.
 */
const buildInvoiceWhere = async ({ userId, isAdmin, filters }: InvoiceViewer & { filters: TInvoiceFilters }) => {
  const conditions: Prisma.EnvelopeWhereInput[] = [];

  if (!isAdmin) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });

    conditions.push({
      OR: [
        { userId },
        {
          recipients: {
            some: { email: { equals: user.email, mode: Prisma.QueryMode.insensitive }, documentDeletedAt: null },
          },
        },
      ],
    });
  }

  const range = invoiceDayRange(filters);

  // Data de envio = evento DOCUMENT_SENT. Documento concluído direto no envio (ninguém para assinar) não tem o evento:
  // vale a data de criação, a mesma que a tela mostra.
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
    deletedAt: null,
    status: filters.status ?? { in: [...INVOICE_LIST_STATUSES] },
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

const toRows = async (envelopes: SelectedEnvelope[], viewer: InvoiceViewer): Promise<InvoiceListRow[]> => {
  const codes = [
    ...new Set(envelopes.flatMap((e) => (e.revalleInvoice?.choiceCode ? [e.revalleInvoice.choiceCode] : []))),
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

  return envelopes.map((envelope) => {
    const invoice = envelope.revalleInvoice;
    const deferred = invoice?.choiceDefer ?? false;
    const code = deferred ? null : (invoice?.choiceCode ?? null);
    const account = code ? accounts.get(code) : undefined;

    const link =
      envelope.userId === viewer.userId
        ? `/t/${envelope.team.url}/documents/${envelope.id}`
        : viewer.isAdmin
          ? `/admin/documents/${envelope.id}`
          : null;

    return {
      id: envelope.id,
      title: envelope.title,
      senderName: envelope.user.name?.trim() || envelope.user.email,
      senderEmail: envelope.user.email,
      sentAt: envelope.auditLogs[0]?.createdAt ?? envelope.createdAt,
      completedAt: envelope.completedAt,
      status: envelope.status as Exclude<DocumentStatus, 'DRAFT'>,
      account: code ? { code, name: account?.name ?? null } : null,
      accountKind: account?.kind ?? null,
      deferred,
      suggestion: readSuggestion(invoice),
      acceptedSuggestion: invoice?.acceptedSuggestion ?? null,
      link,
    };
  });
};

const ORDER_BY = [{ createdAt: 'desc' }, { id: 'desc' }] satisfies Prisma.EnvelopeOrderByWithRelationInput[];

export const findInvoices = async ({ userId, isAdmin, filters, page = 1, perPage = 20 }: FindInvoicesOptions) => {
  const viewer = { userId, isAdmin };
  const where = await buildInvoiceWhere({ ...viewer, filters });

  const [count, envelopes] = await Promise.all([
    prisma.envelope.count({ where }),
    prisma.envelope.findMany({ where, select, orderBy: ORDER_BY, skip: (page - 1) * perPage, take: perPage }),
  ]);

  return {
    data: await toRows(envelopes, viewer),
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
  const viewer = { userId, isAdmin };
  const where = await buildInvoiceWhere({ ...viewer, filters });

  if ((await prisma.envelope.count({ where })) > INVOICE_EXPORT_LIMIT) {
    return { tooMany: true };
  }

  const envelopes = await prisma.envelope.findMany({ where, select, orderBy: ORDER_BY, take: INVOICE_EXPORT_LIMIT });
  const baseUrl = NEXT_PUBLIC_WEBAPP_URL().replace(/\/$/, '');

  const rows: InvoiceExportRow[] = (await toRows(envelopes, viewer)).map((row) => ({
    id: row.id,
    title: row.title,
    senderName: row.senderName,
    sentAt: row.sentAt,
    completedAt: row.completedAt,
    status: INVOICE_STATUS_LABELS[row.status],
    choice: row.deferred ? INVOICE_DEFER_CHOICE : (row.account?.code ?? null),
    accountName: row.account?.name ?? null,
    accountKind: row.accountKind,
    suggestedCode: row.suggestion?.code ?? null,
    confidence: row.suggestion?.confidence ?? null,
    acceptedSuggestion: row.acceptedSuggestion,
    link: row.link ? `${baseUrl}${row.link}` : '',
  }));

  return { tooMany: false, csv: buildInvoiceExportCsv(rows) };
};
