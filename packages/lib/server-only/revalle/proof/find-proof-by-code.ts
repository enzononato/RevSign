import { prisma } from '@documenso/prisma';
import {
  DocumentStatus,
  type RecipientRole,
  RevalleFinanceStatus,
  RevalleInvoiceFileKind,
  RevalleInvoiceStatus,
  type RevalleSupersedeKind,
  SigningStatus,
} from '@prisma/client';

import { REVALLE_COST_CENTERS } from '../../../revalle/invoice/cost-centers';
import { fileFinanceStatus, type InvoicePosition, invoicePositions } from '../../../revalle/invoice/invoice-files';
import { type LoadedInvoiceFile, loadInvoiceFiles } from '../invoice/invoice-files';
import { VERIFICATION_CODE_ALPHABET, VERIFICATION_CODE_REGEX } from './verification-code';

/**
 * Normaliza o que a pessoa digitou: maiúsculas, sem espaços, hífen no meio.
 * Devolve null se não for um código válido (formato e alfabeto), sem tocar no banco.
 */
export const normalizeVerificationCodeInput = (input: string): string | null => {
  const compact = input.toUpperCase().replace(/\s+/g, '');
  const withHyphen = /^[^-]{8}$/.test(compact) ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;

  return VERIFICATION_CODE_REGEX.test(withHyphen) &&
    [...withHyphen.replace('-', '')].every((c) => VERIFICATION_CODE_ALPHABET.includes(c))
    ? withHyphen
    : null;
};

export type RevalleProofLookup = {
  documentTitle: string;
  status: 'COMPLETED' | 'REJECTED' | 'PENDING';
  /** Conclusão (COMPLETED) ou recusa (REJECTED); nulo se em andamento. */
  completedAt: Date | null;
  /** SHA-256 final: só quando há um único arquivo e ele já foi selado. */
  finalSha256: string | null;
  /**
   * Um item por arquivo; `finalSha256` (versão atual) só depois da selagem. `sealedVersions`: todas as selagens
   * do arquivo, da mais antiga para a mais nova (a reselagem acrescenta; cópias antigas continuam conferindo).
   */
  items: { title: string; finalSha256: string | null; sealedVersions: { sha256: string; sealedAt: Date }[] }[];
  /** `factors`, `termVersion` e `termAcceptedAt` como gravados na prova (o certificado mostra os mesmos). */
  signers: {
    nome: string;
    cpfMasked: string | null;
    signedAt: Date;
    role: RecipientRole;
    factors: unknown;
    termVersion: string | null;
    termAcceptedAt: Date | null;
  }[];
  /**
   * Fase 6, só em NF que passou pelo Financeiro: a conta desta versão, a aprovação (nome de quem aprovou, nunca o
   * e-mail) e, se a conta foi trocada ou o centro corrigido, quando e por quê esta versão foi substituída. Nada da nova
   * versão (nem códigos, nem id).
   */
  invoice: {
    account: { code: string; name: string } | null;
    approval: { approverName: string | null; approvedAt: Date } | null;
    isAwaitingApproval: boolean;
    supersededAt: Date | null;
    supersedeKind: RevalleSupersedeKind | null;
    /** Fase 9: com 2+ notas, a nota cuja conta (ou centro) mudou nesta substituição; nulo com uma nota. */
    supersededPosition: InvoicePosition | null;
  } | null;
  /**
   * Fase 7, em qualquer NF com centro de custo (também a concluída como `LEGACY`, sem passar pelo Financeiro): o centro
   * desta versão. Não afirma validação da Contabilidade.
   */
  costCenter: { code: string; name: string } | null;
  /**
   * Fase 9, só com 2+ notas no envio: por nota, na ordem dos arquivos, o rótulo ("Nota 1 de 3 · nf-a.pdf"), a conta e a
   * aprovação dela (pela mesma regra de `invoice`), o centro (pela regra de `costCenter`) e se ela aguarda o Financeiro.
   * Nesse caso `invoice.account`, `invoice.approval` e `costCenter` ficam nulos e `invoice.isAwaitingApproval` falso.
   */
  invoiceDocuments: RevalleProofInvoiceDocumentLookup[] | null;
};

export type RevalleProofInvoiceDocumentLookup = {
  label: string;
  account: { code: string; name: string } | null;
  approval: { approverName: string | null; approvedAt: Date } | null;
  costCenter: { code: string; name: string } | null;
  isAwaitingApproval: boolean;
};

const FINANCE_STATUSES_SHOWN: RevalleFinanceStatus[] = [
  RevalleFinanceStatus.PENDING_APPROVAL,
  RevalleFinanceStatus.APPROVED,
  RevalleFinanceStatus.SUPERSEDED,
];

/**
 * Consulta pública pelo código de verificação. Devolve só o que pode ser público:
 * nunca e-mail, IP, aparelho, local, CPF completo, conteúdo ou URL do arquivo.
 */
export const findRevalleProofByCode = async (code: string): Promise<RevalleProofLookup | null> => {
  const normalized = normalizeVerificationCodeInput(code);

  if (!normalized) {
    return null;
  }

  const proof = await prisma.revalleSignatureProof.findUnique({
    where: { verificationCode: normalized },
    select: {
      recipient: {
        select: {
          envelope: {
            select: {
              id: true,
              title: true,
              status: true,
              completedAt: true,
              deletedAt: true,
              envelopeItems: {
                orderBy: { order: 'asc' },
                select: {
                  title: true,
                  revalleHash: {
                    select: {
                      finalSha256: true,
                      sealedVersions: { orderBy: { sealedAt: 'asc' }, select: { sha256: true, sealedAt: true } },
                    },
                  },
                },
              },
              recipients: {
                select: {
                  name: true,
                  role: true,
                  signingStatus: true,
                  signedAt: true,
                  revalleProof: {
                    select: { signedAt: true, employee: true, factors: true, termVersion: true, termAcceptedAt: true },
                  },
                },
              },
              revalleInvoice: {
                select: {
                  isInvoice: true,
                  financeStatus: true,
                  choiceCode: true,
                  approvedById: true,
                  approvedAt: true,
                  approvedAccountName: true,
                  approvedByName: true,
                  supersededAt: true,
                  supersedeKind: true,
                  supersededEnvelopeItemId: true,
                  costCenterCode: true,
                },
              },
            },
          },
        },
      },
    },
  });

  const envelope = proof?.recipient.envelope;
  const invoiceRow = envelope?.revalleInvoice;
  const isSuperseded =
    invoiceRow?.isInvoice === RevalleInvoiceStatus.YES &&
    invoiceRow.financeStatus === RevalleFinanceStatus.SUPERSEDED &&
    invoiceRow.supersededAt !== null;

  // Excluído ou cancelado: some da consulta pública. A versão de NF substituída pelo Financeiro é escondida das listas
  // como excluída, mas quem tem o código dela vê que foi substituída.
  if (!envelope || (envelope.deletedAt && !isSuperseded) || envelope.status === DocumentStatus.CANCELLED) {
    return null;
  }

  const completed = envelope.status === DocumentStatus.COMPLETED;
  // Recusa: horário gravado em signedAt de quem recusou (a selagem pode ainda não ter virado o status).
  const rejections = envelope.recipients.filter((r) => r.signingStatus === SigningStatus.REJECTED);
  const rejected = !completed && (envelope.status === DocumentStatus.REJECTED || rejections.length > 0);
  const rejectedAt = rejections.reduce<Date | null>(
    (first, r) => (r.signedAt && (!first || r.signedAt < first) ? r.signedAt : first),
    null,
  );
  const items = envelope.envelopeItems.map((item) => ({
    title: item.title,
    finalSha256: completed ? (item.revalleHash?.finalSha256 ?? null) : null,
    sealedVersions: completed ? (item.revalleHash?.sealedVersions ?? []) : [],
  }));

  const signers = envelope.recipients
    .flatMap((recipient) =>
      recipient.revalleProof
        ? [{ ...recipient.revalleProof, role: recipient.role, recipientName: recipient.name }]
        : [],
    )
    .map((p) => {
      const employee = (p.employee ?? null) as { nome?: unknown; cpfMasked?: unknown } | null;

      return {
        // Mesma regra do carimbo e do certificado: nome do RH; sem ele (VIEWER, checagem desligada), o nome do
        // destinatário. Nunca o e-mail (a página é pública).
        nome:
          typeof employee?.nome === 'string' && employee.nome.trim()
            ? employee.nome
            : p.recipientName.trim() || 'Participante',
        cpfMasked: typeof employee?.cpfMasked === 'string' ? employee.cpfMasked : null,
        signedAt: p.signedAt,
        role: p.role,
        factors: p.factors,
        termVersion: p.termVersion,
        termAcceptedAt: p.termAcceptedAt,
      };
    })
    .sort((a, b) => a.signedAt.getTime() - b.signedAt.getTime());

  const base = {
    documentTitle: envelope.title,
    status: completed ? ('COMPLETED' as const) : rejected ? ('REJECTED' as const) : ('PENDING' as const),
    completedAt: completed ? envelope.completedAt : rejected ? rejectedAt : null,
    finalSha256: items.length === 1 ? items[0].finalSha256 : null,
    items,
    signers,
  };

  // Fase 9: com 2+ notas, um bloco por nota; com uma (ou envio de antes da Fase 9 sem as linhas por arquivo), como antes.
  const files = invoiceRow?.isInvoice === RevalleInvoiceStatus.YES ? await loadInvoiceFiles(envelope.id) : [];
  const nfs = files.filter((file) => file.kind === RevalleInvoiceFileKind.NF);

  if (invoiceRow && nfs.length >= 2) {
    const positions = invoicePositions(files);
    const summary = await loadInvoiceSummary(invoiceRow, { rejected });
    const supersededFile = nfs.find((file) => file.envelopeItemId === invoiceRow.supersededEnvelopeItemId);

    return {
      ...base,
      invoice: summary && {
        ...summary,
        account: null,
        approval: null,
        isAwaitingApproval: false,
        supersededPosition: summary.supersededAt && supersededFile ? (positions.get(supersededFile.id) ?? null) : null,
      },
      costCenter: null,
      invoiceDocuments: await Promise.all(
        nfs.flatMap((file) => {
          const position = positions.get(file.id);

          return position ? [loadInvoiceDocument(invoiceRow, file, position, { rejected })] : [];
        }),
      ),
    };
  }

  return {
    ...base,
    invoice: await loadInvoiceSummary(invoiceRow, { rejected }),
    costCenter: toCostCenter(invoiceRow),
    invoiceDocuments: null,
  };
};

/**
 * Fase 9: uma nota de um envio com 2+ notas, pelas regras da nota única: a conta só se o envio passou pelo Financeiro
 * (o nome congelado na aprovação, se aprovada), a aprovação dela (`fileFinanceStatus`), o centro em qualquer situação.
 */
const loadInvoiceDocument = async (
  row: InvoiceRow,
  file: LoadedInvoiceFile,
  position: InvoicePosition,
  { rejected }: { rejected: boolean },
): Promise<RevalleProofInvoiceDocumentLookup> => {
  const label = `Nota ${position.index} de ${position.total} · ${file.title}`;
  const costCenter = toCostCenter({ isInvoice: row.isInvoice, costCenterCode: file.costCenterCode });
  const summary = await loadInvoiceSummary(
    {
      ...row,
      financeStatus: row.financeStatus && fileFinanceStatus(row.financeStatus, file.approvedAt),
      choiceCode: file.choiceCode,
      approvedById: file.approvedById,
      approvedAt: file.approvedAt,
      approvedAccountName: file.approvedAccountName,
      approvedByName: file.approvedByName,
    },
    { rejected },
  );

  return {
    label,
    account: summary?.account ?? null,
    approval: summary?.approval ?? null,
    costCenter,
    isAwaitingApproval: summary?.isAwaitingApproval ?? false,
  };
};

const toCostCenter = (row: Pick<InvoiceRow, 'isInvoice' | 'costCenterCode'> | null | undefined) => {
  if (!row || row.isInvoice !== RevalleInvoiceStatus.YES) {
    return null;
  }

  const center = REVALLE_COST_CENTERS.find((item) => item.code === row.costCenterCode);

  return center ? { code: center.code, name: center.name } : null;
};

type InvoiceRow = {
  isInvoice: RevalleInvoiceStatus;
  financeStatus: RevalleFinanceStatus | null;
  choiceCode: string | null;
  approvedById: number | null;
  approvedAt: Date | null;
  approvedAccountName: string | null;
  approvedByName: string | null;
  supersededAt: Date | null;
  supersedeKind: RevalleSupersedeKind | null;
  supersededEnvelopeItemId: string | null;
  costCenterCode: string | null;
};

const loadInvoiceSummary = async (
  row: InvoiceRow | null | undefined,
  { rejected }: { rejected: boolean },
): Promise<RevalleProofLookup['invoice']> => {
  if (!row || row.isInvoice !== RevalleInvoiceStatus.YES || !row.financeStatus) {
    return null;
  }

  if (!FINANCE_STATUSES_SHOWN.includes(row.financeStatus)) {
    return null;
  }

  const code = row.choiceCode;
  const isApproved =
    row.approvedAt !== null && row.approvedById !== null && row.financeStatus !== RevalleFinanceStatus.PENDING_APPROVAL;

  // Aprovada: o nome congelado na aprovação (a lista pode ter sido reimportada depois); senão, o nome atual.
  const frozenName = isApproved ? row.approvedAccountName : null;

  const [account, approver] = await Promise.all([
    code && frozenName === null
      ? prisma.revalleAccountingAccount.findUnique({ where: { code }, select: { name: true } })
      : null,
    isApproved && row.approvedById !== null && row.approvedByName === null
      ? prisma.user.findUnique({ where: { id: row.approvedById }, select: { name: true } })
      : null,
  ]);

  return {
    account: code ? { code, name: frozenName ?? account?.name ?? '' } : null,
    approval:
      isApproved && row.approvedAt
        ? { approverName: row.approvedByName ?? (approver?.name?.trim() || null), approvedAt: row.approvedAt }
        : null,
    // NF recusada não aguarda mais ninguém: a página pública diria "Aguardando aprovação" de uma nota que acabou.
    isAwaitingApproval: row.financeStatus === RevalleFinanceStatus.PENDING_APPROVAL && !rejected,
    supersededAt: row.financeStatus === RevalleFinanceStatus.SUPERSEDED ? row.supersededAt : null,
    supersedeKind: row.financeStatus === RevalleFinanceStatus.SUPERSEDED ? row.supersedeKind : null,
    supersededPosition: null,
  };
};
