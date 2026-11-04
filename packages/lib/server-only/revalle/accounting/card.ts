import { prisma } from '@documenso/prisma';
import {
  DocumentStatus,
  type RevalleFinanceStatus,
  RevalleInvoiceStatus,
  type RevalleSupersedeKind,
  SigningStatus,
} from '@prisma/client';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { isNewVersionDraftRow } from '../../../revalle/finance/finance-status';
import { REVALLE_COST_CENTERS } from '../../../revalle/invoice/cost-centers';
import { userLabel } from '../finance/card';
import { findVisibleSuccessor, isStaleChangeClaim } from '../finance/successor';

export type AccountingCard = {
  envelopeId: string;
  envelopeStatus: DocumentStatus;
  financeStatus: RevalleFinanceStatus | null;
  costCenter: { code: string; name: string } | null;
  /** Quem validou: o nome congelado na validação, ou o atual (ou o e-mail) quando a pessoa não tinha nome. */
  validatedBy: string | null;
  validatedAt: Date | null;
  version: number;
  previousEnvelopeId: string | null;
  /** A nova versão, só quando ela existe e abre na página da NF (o link não leva a um 404). */
  supersededByEnvelopeId: string | null;
  supersedeReason: string | null;
  supersedeKind: RevalleSupersedeKind | null;
  /** Versão substituída cuja nova versão não existe mais (ou o pedido morreu no meio): corrige de novo. */
  canRetakeChange: boolean;
  /** Alguém recusou: não há o que validar nem corrigir. */
  rejected: boolean;
};

const notFound = () => new AppError(AppErrorCode.NOT_FOUND, { message: 'Nota fiscal não encontrada.' });

/**
 * Cartão "Contabilidade" da página da NF (só para membros; a rota confere). Mesmo acesso da página: NF excluída pelo
 * remetente e rascunho comum de outra pessoa dão 404; a versão substituída escondida e o rascunho de uma nova versão, não.
 */
export const getAccountingCard = async (envelopeId: string): Promise<AccountingCard> => {
  const envelope = await prisma.envelope.findUnique({
    where: { id: envelopeId },
    select: {
      id: true,
      status: true,
      deletedAt: true,
      recipients: { where: { signingStatus: SigningStatus.REJECTED }, select: { id: true }, take: 1 },
      revalleInvoice: true,
    },
  });

  const row = envelope?.revalleInvoice;

  if (!envelope || !row || row.isInvoice !== RevalleInvoiceStatus.YES) {
    throw notFound();
  }

  const isSuperseded = row.financeStatus === 'SUPERSEDED';
  const hiddenSuperseded = isSuperseded && envelope.status !== DocumentStatus.COMPLETED;

  if (envelope.deletedAt && !hiddenSuperseded) {
    throw notFound();
  }

  if (envelope.status === DocumentStatus.DRAFT && !isNewVersionDraftRow(row)) {
    throw notFound();
  }

  const [validatedBy, successor, canRetakeChange] = await Promise.all([
    row.costCenterValidatedAt ? (row.costCenterValidatedByName ?? userLabel(row.costCenterValidatedById)) : null,
    isSuperseded ? findVisibleSuccessor(row.supersededByEnvelopeId) : null,
    isStaleChangeClaim(row, new Date()),
  ]);

  const center = REVALLE_COST_CENTERS.find((item) => item.code === row.costCenterCode);

  return {
    envelopeId: envelope.id,
    envelopeStatus: envelope.status,
    financeStatus: row.financeStatus,
    costCenter: center ? { code: center.code, name: center.name } : null,
    validatedBy,
    validatedAt: row.costCenterValidatedAt,
    version: row.version,
    previousEnvelopeId: row.previousEnvelopeId,
    supersededByEnvelopeId: successor?.id ?? null,
    supersedeReason: row.supersedeReason,
    supersedeKind: row.supersedeKind,
    canRetakeChange,
    rejected: envelope.recipients.length > 0,
  };
};
