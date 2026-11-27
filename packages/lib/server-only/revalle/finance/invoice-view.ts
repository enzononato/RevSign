import { prisma } from '@documenso/prisma';
import {
  DocumentStatus,
  EnvelopeType,
  type RecipientRole,
  RevalleFinanceStatus,
  RevalleInvoiceFileKind,
  RevalleInvoiceStatus,
  type RevalleSupersedeKind,
  type SigningStatus,
} from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { normalizeEmail } from '../../../revalle/email-domain';
import { isNewVersionDraftRow } from '../../../revalle/finance/finance-status';
import type { BoletoData } from '../../../revalle/invoice/boleto';
import type { BoletoWarning } from '../../../revalle/invoice/boleto-match';
import { costCenterLabel } from '../../../revalle/invoice/cost-centers';
import { type InvoiceDataSummary, toInvoiceDataSummary } from '../../../revalle/invoice/invoice-data';
import { fileFinanceStatus, type InvoicePosition, invoicePositions } from '../../../revalle/invoice/invoice-files';
import { isAdmin as isAdminUser } from '../../../utils/is-admin';
import { isAccountingMember } from '../accounting/members';
import { boletoStates } from '../invoice/classify';
import {
  findEnvelopeNoteDuplicatesOrEmpty,
  findInvoiceDuplicatesOrEmpty,
  type InvoiceDuplicate,
} from '../invoice/duplicates';
import { type LoadedInvoiceFile, loadInvoiceFiles, refreshLegacyInvoiceFiles } from '../invoice/invoice-files';
import { invoiceScopeWhere, isInvoiceInUserScope } from '../invoice/unit-scope';
import { isFinanceMember } from './members';
import { findVisibleSuccessor } from './successor';

/**
 * Página da NF só de leitura (Fase 6): `/notas-fiscais/:envelopeId`, para quem é do Financeiro (e, desde a Fase 7, da
 * Contabilidade) e para quem está na NF.
 *
 * Quem abre:
 * - o admin: qualquer NF (inclusive a versão substituída escondida e o rascunho);
 * - o Financeiro e a Contabilidade (v.26: só as das unidades do seu escopo; fora delas, como qualquer pessoa): qualquer NF
 *   enviada, a versão substituída escondida e o rascunho de uma nova versão
 *   (envio parado, `isNewVersionDraftRow`); o rascunho comum de outra pessoa, não;
 * - o dono: as dele;
 * - quem é destinatário (pelo e-mail): a NF já enviada; o rascunho de uma nova versão também (o aviso da troca leva a
 *   ele e o envio pode ter falhado).
 * NF excluída pelo remetente: só o admin (a versão substituída escondida pelo Financeiro não conta como excluída).
 * Destinatário que escondeu o documento da própria lista: 404, como na lista.
 * Qualquer outro caso, ou um documento que não é NF: 404, sem revelar que existe.
 */
export type InvoiceViewer = { isAdmin: boolean; isFinance: boolean; isAccounting: boolean; isOwner: boolean };

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
          costCenterCode: true,
          version: true,
          previousEnvelopeId: true,
          supersededByEnvelopeId: true,
          supersededAt: true,
          supersedeReason: true,
          supersedeKind: true,
          supplierName: true,
          invoiceNumber: true,
          totalAmountCents: true,
          accessKeys: true,
          fileSha256: true,
        },
      },
    },
  });

type LoadedEnvelope = NonNullable<Awaited<ReturnType<typeof loadEnvelope>>>;

/** Quem pode abrir (ou `null` = 404). Admin, Financeiro e Contabilidade lidos do banco a cada pedido. */
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
  const [isFinance, isAccounting] = await Promise.all([isFinanceMember(userId), isAccountingMember(userId)]);
  const isOwner = envelope.userId === userId;
  // O rascunho comum é trabalho do dono: o perfil não vale nele. Quem o abre por ser admin ou dono vê a leitura, sem os
  // cartões, cujas rotas dão 404 nele.
  const isOpenToProfiles = envelope.status !== DocumentStatus.DRAFT || isNewVersionDraftRow(invoice);
  // v.26: fora das unidades da pessoa, o perfil não vale (ela só abre como dona ou destinatária, sem os cartões).
  const isProfileInScope =
    (isFinance || isAccounting) && isOpenToProfiles
      ? isAdmin || (await isInvoiceInUserScope({ envelopeId: envelope.id, userId }))
      : false;
  const viewer = {
    isAdmin,
    isFinance: isFinance && isProfileInScope,
    isAccounting: isAccounting && isProfileInScope,
    isOwner,
  };

  if (isAdmin) {
    return viewer;
  }

  const hiddenSuperseded =
    invoice.financeStatus === RevalleFinanceStatus.SUPERSEDED && envelope.status !== DocumentStatus.COMPLETED;

  if (envelope.deletedAt && !hiddenSuperseded) {
    return null;
  }

  // A Contabilidade lê o mesmo que o Financeiro.
  if (viewer.isFinance || viewer.isAccounting || isOwner) {
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
    /** Centro de custo ("101 – Puxada"), para quem só está vendo. */
    costCenterLabel: string | null;
    version: number;
    previous: { id: string; title: string } | null;
    next: { id: string; title: string } | null;
    supersededAt: Date | null;
    supersedeReason: string | null;
    supersedeKind: RevalleSupersedeKind | null;
  };
  /** Fase 8: fornecedor, número e valor que a IA leu da NF (podem estar errados); nulo quando os três estão vazios. */
  invoiceData: InvoiceDataSummary | null;
  /**
   * Fase 8: as outras notas vivas com uma chave em comum ou o mesmo arquivo, de qualquer unidade. O admin vê o título e o
   * id (para o link); o Financeiro e a Contabilidade também, mas só das notas das suas unidades ou enviadas por eles
   * (v.26); nos outros casos, e para o dono, só data, remetente e situação (`id` e `title` nulos), porque a pessoa pode
   * não ter acesso à outra; quem só assina não vê nada.
   */
  duplicates: InvoiceViewDuplicate[];
  /**
   * Fase 9: as notas do envio, na ordem dos arquivos (com uma nota, uma entrada com o mesmo que `finance` e
   * `invoiceData`). Cada uma com a conta, o centro, a situação no Financeiro e o que a IA leu daquela nota, e as duplicadas
   * dela (com uma nota, as de `duplicates`).
   */
  documents: InvoiceViewDocument[];
  /**
   * Fase 9: os boletos do envio, com os dados lidos e a conferência com as notas. Os avisos só para o Financeiro, a
   * Contabilidade, o admin e o dono (quem só assina recebe a lista sem os avisos).
   */
  boletos: InvoiceViewBoleto[];
  viewer: InvoiceViewer;
  /** Página completa do documento para quem tem: o dono (no time) e o admin (no painel). */
  documentPath: string | null;
};

export type InvoiceViewDocument = {
  envelopeItemId: string;
  title: string;
  position: InvoicePosition;
  account: { code: string; name: string | null } | null;
  costCenterLabel: string | null;
  financeStatus: RevalleFinanceStatus | null;
  invoiceData: InvoiceDataSummary | null;
  duplicates: InvoiceViewDuplicate[];
};

export type InvoiceViewBoleto = {
  envelopeItemId: string;
  title: string;
  data: BoletoData | null;
  warnings: Array<BoletoWarning & { message: string }>;
};

export type InvoiceViewDuplicate = {
  id: string | null;
  title: string | null;
  sentAt: Date | null;
  senderName: string;
  status: 'PENDING' | 'COMPLETED';
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

  const code = invoice.choiceCode;
  const account = code
    ? await prisma.revalleAccountingAccount.findUnique({ where: { code }, select: { name: true } })
    : null;

  const [previous, next] = await Promise.all([
    linkedVersion(invoice.previousEnvelopeId),
    invoice.financeStatus === RevalleFinanceStatus.SUPERSEDED
      ? findVisibleSuccessor(invoice.supersededByEnvelopeId)
      : null,
  ]);

  // Quem decide sobre a nota abre as outras; o dono (que pode não ter acesso a elas) só fica sabendo que existem.
  const canOpenOthers = viewer.isAdmin || viewer.isFinance || viewer.isAccounting;
  const showDuplicates = canOpenOthers || viewer.isOwner;
  const toViewDuplicate = ({ envelopeId, title, sentAt, senderName, status }: InvoiceDuplicate) => ({
    id: openable(envelopeId) ? envelopeId : null,
    title: openable(envelopeId) ? title : null,
    sentAt,
    senderName,
    status,
  });

  // Fase 9: as notas e os boletos (linhas de arquivo; um envio de antes da Fase 9 é refeito na primeira leitura).
  await refreshLegacyInvoiceFiles(envelope.id);

  const files = await loadInvoiceFiles(envelope.id);
  const nfs = files.filter((file) => file.kind === RevalleInvoiceFileKind.NF);

  // As duplicadas de cada nota (pela chave e pelo arquivo dela) e, em cima, a união (com uma nota, as dela). Sem linhas de
  // arquivo (o envio antigo que não se refez), a busca de sempre, pela linha do envio.
  const noteDuplicates: { byFile: Map<string, InvoiceDuplicate[]>; union: InvoiceDuplicate[] } = !showDuplicates
    ? { byFile: new Map(), union: [] }
    : nfs.length > 0
      ? await findEnvelopeNoteDuplicatesOrEmpty({
          envelopeId: envelope.id,
          files: nfs,
          financeStatus: invoice.financeStatus,
        })
      : {
          byFile: new Map(),
          union: await findInvoiceDuplicatesOrEmpty({
            envelopeId: envelope.id,
            accessKeys: invoice.accessKeys,
            fileSha256: invoice.fileSha256,
            financeStatus: invoice.financeStatus,
          }),
        };
  // v.26: a busca compara todas as unidades (uma nota lançada duas vezes em unidades diferentes também avisa), mas o
  // título e o link da outra só vão a quem a abriria: o admin, ou o perfil quando ela é das suas unidades ou é dele.
  const openableIds =
    canOpenOthers && !viewer.isAdmin
      ? await findOpenableDuplicateIds(
          userId,
          [...noteDuplicates.union, ...[...noteDuplicates.byFile.values()].flat()].map((other) => other.envelopeId),
        )
      : null;
  const openable = (otherId: string) => canOpenOthers && (openableIds === null || openableIds.has(otherId));
  const duplicates = noteDuplicates.union.map(toViewDuplicate);
  const documents = await toViewDocuments({
    nfs,
    positions: invoicePositions(files),
    envelopeFinanceStatus: invoice.financeStatus,
    duplicatesOf: (file) => (noteDuplicates.byFile.get(file.id) ?? []).map(toViewDuplicate),
  });
  const boletos = toViewBoletos(files, { showWarnings: canOpenOthers || viewer.isOwner });

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
      costCenterLabel: invoice.costCenterCode ? costCenterLabel(invoice.costCenterCode) : null,
      version: invoice.version,
      previous,
      next,
      supersededAt: invoice.supersededAt,
      supersedeReason: invoice.supersedeReason,
      supersedeKind: invoice.supersedeKind,
    },
    invoiceData: toInvoiceDataSummary(invoice),
    duplicates,
    documents,
    boletos,
    viewer,
    documentPath,
  };
};

const findOpenableDuplicateIds = async (userId: number, envelopeIds: string[]): Promise<Set<string>> => {
  const ids = [...new Set(envelopeIds)];

  if (ids.length === 0) {
    return new Set();
  }

  const rows = await prisma.envelope.findMany({
    where: { id: { in: ids }, OR: [{ userId }, invoiceScopeWhere(userId)] },
    select: { id: true },
  });

  return new Set(rows.map((row) => row.id));
};

/** Fase 9: uma entrada por nota, na ordem dos arquivos. */
const toViewDocuments = async ({
  nfs,
  positions,
  envelopeFinanceStatus,
  duplicatesOf,
}: {
  nfs: LoadedInvoiceFile[];
  positions: Map<string, InvoicePosition>;
  envelopeFinanceStatus: RevalleFinanceStatus | null;
  duplicatesOf: (file: LoadedInvoiceFile) => InvoiceViewDuplicate[];
}): Promise<InvoiceViewDocument[]> => {
  const codes = [...new Set(nfs.map((file) => file.choiceCode).filter((code): code is string => Boolean(code)))];
  const names = new Map(
    codes.length > 0
      ? (
          await prisma.revalleAccountingAccount.findMany({
            where: { code: { in: codes } },
            select: { code: true, name: true },
          })
        ).map((account) => [account.code, account.name])
      : [],
  );

  return nfs.map((file) => ({
    envelopeItemId: file.envelopeItemId,
    title: file.title,
    position: positions.get(file.id) ?? { index: 1, total: nfs.length },
    account: file.choiceCode ? { code: file.choiceCode, name: names.get(file.choiceCode) ?? null } : null,
    costCenterLabel: file.costCenterCode ? costCenterLabel(file.costCenterCode) : null,
    financeStatus: fileFinanceStatus(envelopeFinanceStatus, file.approvedAt),
    invoiceData: toInvoiceDataSummary(file),
    duplicates: duplicatesOf(file),
  }));
};

/**
 * Fase 9: os boletos do envio conferidos com as notas, a mesma conta do diálogo de envio (`boletoStates`). Quem só assina
 * recebe a lista sem os avisos.
 */
const toViewBoletos = (
  files: LoadedInvoiceFile[],
  { showWarnings }: { showWarnings: boolean },
): InvoiceViewBoleto[] => {
  const states = boletoStates(files);

  return files.flatMap((file) => {
    const state = states.get(file.id);

    return state
      ? [
          {
            envelopeItemId: file.envelopeItemId,
            title: file.title,
            data: state.data,
            warnings: showWarnings ? state.warnings : [],
          },
        ]
      : [];
  });
};

/**
 * Arquivo de uma NF para a prévia e o "Baixar PDF" da página (mesmo acesso da página). Devolve o `documentData` do item (a
 * versão atual: a assinada, depois de selada), o nome do arquivo e se o documento já concluiu, ou 404.
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
    select: { title: true, documentData: { select: { type: true, data: true } } },
  });

  if (!item) {
    throw notFound();
  }

  return {
    documentData: item.documentData,
    title: item.title,
    isCompleted: envelope.status === DocumentStatus.COMPLETED,
  };
};
