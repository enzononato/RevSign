import { prisma } from '@documenso/prisma';
import {
  DocumentStatus,
  type RecipientRole,
  RevalleFinanceStatus,
  RevalleInvoiceStatus,
  SigningStatus,
} from '@prisma/client';

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
  signers: { nome: string; cpfMasked: string | null; signedAt: Date; role: RecipientRole }[];
  /**
   * Fase 6, só em NF que passou pelo Financeiro: a conta desta versão, a aprovação (nome de quem aprovou, nunca o
   * e-mail) e, se a conta foi trocada, quando esta versão foi substituída. Nada da nova versão (nem códigos, nem id).
   */
  invoice: {
    account: { code: string; name: string } | null;
    approval: { approverName: string | null; approvedAt: Date } | null;
    isAwaitingApproval: boolean;
    supersededAt: Date | null;
  } | null;
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
                  revalleProof: { select: { signedAt: true, employee: true } },
                },
              },
              revalleInvoice: {
                select: {
                  isInvoice: true,
                  financeStatus: true,
                  choiceCode: true,
                  choiceDefer: true,
                  approvedById: true,
                  approvedAt: true,
                  approvedAccountName: true,
                  approvedByName: true,
                  supersededAt: true,
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
      };
    })
    .sort((a, b) => a.signedAt.getTime() - b.signedAt.getTime());

  return {
    documentTitle: envelope.title,
    status: completed ? 'COMPLETED' : rejected ? 'REJECTED' : 'PENDING',
    completedAt: completed ? envelope.completedAt : rejected ? rejectedAt : null,
    finalSha256: items.length === 1 ? items[0].finalSha256 : null,
    items,
    signers,
    invoice: await loadInvoiceSummary(invoiceRow),
  };
};

type InvoiceRow = {
  isInvoice: RevalleInvoiceStatus;
  financeStatus: RevalleFinanceStatus | null;
  choiceCode: string | null;
  choiceDefer: boolean;
  approvedById: number | null;
  approvedAt: Date | null;
  approvedAccountName: string | null;
  approvedByName: string | null;
  supersededAt: Date | null;
};

const loadInvoiceSummary = async (row: InvoiceRow | null | undefined): Promise<RevalleProofLookup['invoice']> => {
  if (!row || row.isInvoice !== RevalleInvoiceStatus.YES || !row.financeStatus) {
    return null;
  }

  if (!FINANCE_STATUSES_SHOWN.includes(row.financeStatus)) {
    return null;
  }

  const code = !row.choiceDefer && row.choiceCode ? row.choiceCode : null;
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
    isAwaitingApproval: row.financeStatus === RevalleFinanceStatus.PENDING_APPROVAL,
    supersededAt: row.financeStatus === RevalleFinanceStatus.SUPERSEDED ? row.supersededAt : null,
  };
};
