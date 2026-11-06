import { prisma } from '@documenso/prisma';
import {
  DocumentStatus,
  EnvelopeType,
  Prisma,
  RecipientRole,
  RevalleFinanceStatus,
  RevalleInvoiceStatus,
  RevalleSuggestionStatus,
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
import { findDuplicateEnvelopeIdsOrEmpty, sentAtOf } from './duplicates';

export type InvoiceViewer = { userId: number; isAdmin: boolean };

/** REVALLE (redesign v3): quem assina a NF, para os encaixes do cartão da lista (sem cópia nem visualizador). */
export type InvoiceListRecipient = {
  name: string;
  email: string;
  signingStatus: SigningStatus;
  role: RecipientRole;
};

/** Quem vê a lista, com as marcas do Financeiro e da Contabilidade lidas do banco uma vez por pedido. */
type ResolvedViewer = InvoiceViewer & { isFinance: boolean; isAccounting: boolean };

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

/**
 * "Aguardando o Financeiro": a conta ainda não foi aprovada, ou a nova versão ficou em rascunho e espera o "Enviar de
 * novo". A fila do Financeiro e o contador do menu leem este filtro. A NF excluída pelo remetente não espera ninguém
 * (`approve` responde 404 nela), nem para o admin que também é do Financeiro.
 */
export const financePendingWhere = {
  deletedAt: null,
  OR: [awaitingApprovalWhere, newVersionDraftWhere],
} satisfies Prisma.EnvelopeWhereInput;

/**
 * "Aguardando a Contabilidade": NF ainda válida (não substituída), enviada ou concluída, sem recusa, não excluída e sem a
 * validação do centro, ou a nova versão que ficou em rascunho (a Contabilidade também a envia de novo, mesmo já validada
 * pela correção). NF sem centro de custo também espera (a Contabilidade define o primeiro centro). A fila da
 * Contabilidade, o contador do menu e o aviso do admin leem este filtro.
 */
export const accountingPendingWhere = {
  deletedAt: null,
  OR: [
    {
      revalleInvoice: {
        costCenterValidatedAt: null,
        OR: [{ financeStatus: null }, { financeStatus: { not: RevalleFinanceStatus.SUPERSEDED } }],
      },
      status: { in: APPROVABLE_STATUSES },
      recipients: { none: { signingStatus: SigningStatus.REJECTED } },
    },
    newVersionDraftWhere,
  ],
} satisfies Prisma.EnvelopeWhereInput;

const accountingFilterWhere = (filter: AccountingFilter | undefined): Prisma.EnvelopeWhereInput | null => {
  switch (filter) {
    case 'pendentes':
      return accountingPendingWhere;
    case 'validadas':
      return { revalleInvoice: { costCenterValidatedAt: { not: null } } };
    default:
      return null;
  }
};

const financeFilterWhere = (filter: FinanceFilter | undefined): Prisma.EnvelopeWhereInput | null => {
  const stateIs = (financeStatus: RevalleFinanceStatus) => ({ revalleInvoice: { financeStatus } });

  switch (filter) {
    case 'pendentes':
      return financePendingWhere;
    case 'aguardando-aprovacao':
      return awaitingApprovalWhere;
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
 * a cada pedido: desmarcado, deixa de ver na hora); Fase 7: a Contabilidade também. NF excluída pelo remetente some
 * para o dono, para os destinatários, para o Financeiro e para a Contabilidade, mas o admin continua vendo (a
 * contabilidade pode já ter lançado).
 *
 * Fase 6, além das NFs enviadas:
 * - o rascunho de uma nova versão, com o envio parado (`isNewVersionDraftRow`), para o Financeiro, a Contabilidade e o dono
 *   (quem assina ainda não recebeu nada); o rascunho comum nunca aparece;
 * - a versão pendente substituída (escondida pelo upstream), para o dono, os destinatários, o Financeiro e a
 *   Contabilidade.
 */
const buildInvoiceWhere = async ({
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

  const financeCondition = financeFilterWhere(filters.finance);

  if (financeCondition) {
    conditions.push(financeCondition);
  }

  const accountingCondition = accountingFilterWhere(filters.accounting);

  if (accountingCondition) {
    conditions.push(accountingCondition);
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
      ...(filters.accountCode ? { choiceCode: filters.accountCode } : {}),
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
  // REVALLE (redesign v3): só leitura, para os encaixes; cópia e visualizador não assinam.
  recipients: {
    where: { role: { notIn: [RecipientRole.CC, RecipientRole.VIEWER] } },
    orderBy: [{ signingOrder: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
    select: { name: true, email: true, signingStatus: true, role: true },
  },
  revalleInvoice: {
    select: {
      choiceCode: true,
      acceptedSuggestion: true,
      suggestionStatus: true,
      suggestion: true,
      supplierName: true,
      invoiceNumber: true,
      totalAmountCents: true,
      accessKeys: true,
      fileSha256: true,
      financeStatus: true,
      approvedById: true,
      version: true,
      costCenterCode: true,
      costCenterValidatedAt: true,
      costCenterValidatedById: true,
      costCenterValidatedByName: true,
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

/** A linha da lista com as chaves de acesso, que só a planilha usa (a lista não as mostra). */
type InvoiceRowWithKeys = InvoiceListRow & { accessKeys: string[] };

const toRows = async (envelopes: SelectedEnvelope[], viewer: ResolvedViewer): Promise<InvoiceRowWithKeys[]> => {
  const codes = [
    ...new Set(envelopes.flatMap((e) => (e.revalleInvoice?.choiceCode ? [e.revalleInvoice.choiceCode] : []))),
  ];
  // Quem aprovou e, desde a Fase 7, quem validou o centro (o nome congelado vale; o atual só quando ele ficou vazio).
  const approverIds = [
    ...new Set(
      envelopes.flatMap((e) => [
        ...(e.revalleInvoice?.approvedById ? [e.revalleInvoice.approvedById] : []),
        ...(e.revalleInvoice?.costCenterValidatedById ? [e.revalleInvoice.costCenterValidatedById] : []),
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

  // Fase 8: a marca "Possível duplicada" é de quem decide sobre a nota; para os outros nem se consulta.
  const duplicateIds =
    viewer.isFinance || viewer.isAccounting || viewer.isAdmin
      ? await findDuplicateEnvelopeIdsOrEmpty(
          envelopes.flatMap((envelope) =>
            envelope.revalleInvoice
              ? [
                  {
                    envelopeId: envelope.id,
                    accessKeys: envelope.revalleInvoice.accessKeys,
                    fileSha256: envelope.revalleInvoice.fileSha256,
                  },
                ]
              : [],
          ),
        )
      : new Set<string>();

  return envelopes.map((envelope) => {
    const invoice = envelope.revalleInvoice;
    const code = invoice?.choiceCode ?? null;
    const account = code ? accounts.get(code) : undefined;
    const financeStatus = invoice?.financeStatus ?? null;
    const isDraft = envelope.status === DocumentStatus.DRAFT;

    const hiddenSuperseded =
      financeStatus === RevalleFinanceStatus.SUPERSEDED && envelope.status !== DocumentStatus.COMPLETED;
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
      title: envelope.title,
      senderName: envelope.user.name?.trim() || envelope.user.email,
      senderEmail: envelope.user.email,
      sentAt: isDraft ? null : sentAtOf(envelope),
      completedAt: envelope.completedAt,
      status: envelope.status as InvoiceRowStatus,
      deleted,
      account: code ? { code, name: account?.name ?? null } : null,
      accountKind: account?.kind ?? null,
      suggestion: readSuggestion(invoice),
      invoiceData: invoice ? toInvoiceDataSummary(invoice) : null,
      isPossibleDuplicate: duplicateIds.has(envelope.id),
      accessKeys: invoice?.accessKeys ?? [],
      acceptedSuggestion: invoice?.acceptedSuggestion ?? null,
      financeStatus,
      version: invoice?.version ?? 1,
      approvedBy: invoice?.approvedById ? (approvers.get(invoice.approvedById) ?? null) : null,
      costCenterCode: invoice?.costCenterCode ?? null,
      costCenterLabel: invoice?.costCenterCode ? costCenterLabel(invoice.costCenterCode) : null,
      costCenterValidatedAt: invoice?.costCenterValidatedAt ?? null,
      costCenterValidatedBy: invoice?.costCenterValidatedAt
        ? (invoice.costCenterValidatedByName ??
          (invoice.costCenterValidatedById ? (approvers.get(invoice.costCenterValidatedById) ?? null) : null))
        : null,
      link,
      recipients: envelope.recipients, // REVALLE (redesign v3)
    };
  });
};

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

/** A lista não leva as chaves de acesso. */
const withoutKeys = ({ accessKeys: _accessKeys, ...row }: InvoiceRowWithKeys): InvoiceListRow => row;

const resolveViewer = async ({ userId, isAdmin }: InvoiceViewer): Promise<ResolvedViewer> => {
  const [isFinance, isAccounting] = await Promise.all([isFinanceMember(userId), isAccountingMember(userId)]);

  return { userId, isAdmin, isFinance, isAccounting };
};

export const findInvoices = async ({ userId, isAdmin, filters, page = 1, perPage = 20 }: FindInvoicesOptions) => {
  const viewer = await resolveViewer({ userId, isAdmin });
  const ids = await findOrderedIds(await buildInvoiceWhere({ ...viewer, filters }));
  const count = ids.length;

  return {
    data: (await findRowsInOrder(ids.slice((page - 1) * perPage, page * perPage), viewer)).map(withoutKeys),
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
  }));

  return { tooMany: false, csv: buildInvoiceExportCsv(rows) };
};
