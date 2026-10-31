import { prisma } from '@documenso/prisma';
import {
  DocumentStatus,
  EnvelopeType,
  type RecipientRole,
  RevalleFinanceStatus,
  RevalleInvoiceStatus,
  type SigningStatus,
} from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { normalizeEmail } from '../../../revalle/email-domain';
import { isAdmin as isAdminUser } from '../../../utils/is-admin';
import { isFinanceMember } from './members';
import { findVisibleSuccessor } from './successor';

/**
 * Página da NF só de leitura (Fase 6): `/notas-fiscais/:envelopeId`, para quem é do Financeiro e para quem está na NF.
 *
 * Quem abre:
 * - o Financeiro e o admin: qualquer NF (inclusive o rascunho retido e a versão substituída escondida);
 * - o dono: as dele;
 * - quem é destinatário (pelo e-mail): a NF já enviada; o rascunho de uma nova versão também (o aviso da troca leva a
 *   ele e o envio pode ter falhado).
 * NF excluída pelo remetente: só o admin (a versão substituída escondida pelo Financeiro não conta como excluída).
 * Destinatário que escondeu o documento da própria lista: 404, como na lista.
 * Qualquer outro caso, ou um documento que não é NF: 404, sem revelar que existe.
 */
export type InvoiceViewer = { isAdmin: boolean; isFinance: boolean; isOwner: boolean };

const notFound = () => new AppError(AppErrorCode.NOT_FOUND, { message: 'Nota fiscal não encontrada.' });

const loadEnvelope = async (envelopeId: string) =>
  await prisma.envelope.findFirst({
    where: { id: envelopeId, type: EnvelopeType.DOCUMENT },
    select: {
      id: true,
      title: true,
      status: true,
      userId: true,
      deletedAt: true,
      createdAt: true,
      completedAt: true,
      team: { select: { url: true } },
      user: { select: { name: true, email: true } },
      recipients: {
        orderBy: [{ signingOrder: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          signingStatus: true,
          signedAt: true,
          documentDeletedAt: true,
        },
      },
      envelopeItems: { orderBy: { order: 'asc' }, select: { id: true, title: true, documentDataId: true } },
      revalleInvoice: {
        select: {
          isInvoice: true,
          financeStatus: true,
          choiceCode: true,
          choiceDefer: true,
          version: true,
          previousEnvelopeId: true,
          supersededByEnvelopeId: true,
          supersededAt: true,
          supersedeReason: true,
        },
      },
    },
  });

type LoadedEnvelope = NonNullable<Awaited<ReturnType<typeof loadEnvelope>>>;

/** Quem pode abrir (ou `null` = 404). Admin e Financeiro lidos do banco a cada pedido. */
const resolveViewer = async (envelope: LoadedEnvelope, userId: number): Promise<InvoiceViewer | null> => {
  const invoice = envelope.revalleInvoice;

  if (!invoice || invoice.isInvoice !== RevalleInvoiceStatus.YES) {
    return null;
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, roles: true } });

  if (!user) {
    return null;
  }

  const isAdmin = isAdminUser(user);
  const isFinance = await isFinanceMember(userId);
  const isOwner = envelope.userId === userId;
  const viewer = { isAdmin, isFinance, isOwner };

  if (isAdmin) {
    return viewer;
  }

  const hiddenSuperseded =
    invoice.financeStatus === RevalleFinanceStatus.SUPERSEDED && envelope.status !== DocumentStatus.COMPLETED;

  if (envelope.deletedAt && !hiddenSuperseded) {
    return null;
  }

  if (isFinance || isOwner) {
    return viewer;
  }

  const email = normalizeEmail(user.email);
  // Quem escondeu o documento da própria lista também não o abre aqui (a versão substituída foi escondida pela troca,
  // não pela pessoa).
  const isRecipient = envelope.recipients.some(
    (recipient) =>
      normalizeEmail(recipient.email) === email && (recipient.documentDeletedAt === null || hiddenSuperseded),
  );
  const isNewVersionDraft = envelope.status === DocumentStatus.DRAFT && invoice.previousEnvelopeId !== null;

  return isRecipient && (envelope.status !== DocumentStatus.DRAFT || isNewVersionDraft) ? viewer : null;
};

export type InvoiceView = {
  id: string;
  title: string;
  status: DocumentStatus;
  createdAt: Date;
  completedAt: Date | null;
  sender: { name: string; email: string };
  recipients: {
    id: number;
    name: string;
    email: string;
    role: RecipientRole;
    signingStatus: SigningStatus;
    signedAt: Date | null;
  }[];
  items: { id: string; title: string; documentDataId: string }[];
  finance: {
    status: RevalleFinanceStatus | null;
    account: { code: string; name: string | null } | null;
    deferred: boolean;
    version: number;
    previous: { id: string; title: string } | null;
    next: { id: string; title: string } | null;
    supersededAt: Date | null;
    supersedeReason: string | null;
  };
  viewer: InvoiceViewer;
  /** Página completa do documento para quem tem: o dono (no time) e o admin (no painel). */
  documentPath: string | null;
};

const linkedVersion = async (envelopeId: string | null) => {
  if (!envelopeId) {
    return null;
  }

  const envelope = await prisma.envelope.findUnique({ where: { id: envelopeId }, select: { id: true, title: true } });

  return envelope ?? null;
};

/** Dados da página da NF. Sem acesso (ou não é NF): 404. */
export const getInvoiceView = async ({
  envelopeId,
  userId,
}: {
  envelopeId: string;
  userId: number;
}): Promise<InvoiceView> => {
  const envelope = await loadEnvelope(envelopeId);

  if (!envelope) {
    throw notFound();
  }

  const viewer = await resolveViewer(envelope, userId);
  const invoice = envelope.revalleInvoice;

  if (!viewer || !invoice) {
    throw notFound();
  }

  const code = invoice.choiceDefer ? null : invoice.choiceCode;
  const account = code
    ? await prisma.revalleAccountingAccount.findUnique({ where: { code }, select: { name: true } })
    : null;

  const [previous, next] = await Promise.all([
    linkedVersion(invoice.previousEnvelopeId),
    invoice.financeStatus === RevalleFinanceStatus.SUPERSEDED
      ? findVisibleSuccessor(invoice.supersededByEnvelopeId)
      : null,
  ]);

  const documentPath =
    viewer.isOwner && envelope.deletedAt === null
      ? `/t/${envelope.team.url}/documents/${envelope.id}`
      : viewer.isAdmin
        ? `/admin/documents/${envelope.id}`
        : null;

  return {
    id: envelope.id,
    title: envelope.title,
    status: envelope.status,
    createdAt: envelope.createdAt,
    completedAt: envelope.completedAt,
    sender: { name: envelope.user.name?.trim() || envelope.user.email, email: envelope.user.email },
    recipients: envelope.recipients.map(({ documentDeletedAt: _hidden, ...recipient }) => recipient),
    items: envelope.envelopeItems,
    finance: {
      status: invoice.financeStatus,
      account: code ? { code, name: account?.name ?? null } : null,
      deferred: invoice.choiceDefer,
      version: invoice.version,
      previous,
      next,
      supersededAt: invoice.supersededAt,
      supersedeReason: invoice.supersedeReason,
    },
    viewer,
    documentPath,
  };
};

/**
 * Arquivo de uma NF para a prévia da página (mesmo acesso da página). Devolve o `documentData` do item (a versão atual:
 * a assinada, depois de selada), ou 404.
 */
export const getInvoiceViewFile = async ({
  envelopeId,
  itemId,
  userId,
}: {
  envelopeId: string;
  itemId: string;
  userId: number;
}) => {
  const envelope = await loadEnvelope(envelopeId);

  if (!envelope || !(await resolveViewer(envelope, userId))) {
    throw notFound();
  }

  const item = await prisma.envelopeItem.findFirst({
    where: { id: itemId, envelopeId },
    select: { documentData: { select: { type: true, data: true } } },
  });

  if (!item) {
    throw notFound();
  }

  return item.documentData;
};
