import { kyselyPrisma, sql } from '@documenso/prisma';
import {
  DocumentStatus,
  EnvelopeType,
  RecipientRole,
  RevalleFinanceStatus, // REVALLE:
  RevalleInvoiceStatus, // REVALLE:
  SigningStatus,
} from '@prisma/client';
import { DateTime } from 'luxon';

import { holdSealForFinance, retryFinanceApprovalRequests } from '../../../server-only/revalle/finance/seal-hold'; // REVALLE:
import { mapSecondaryIdToDocumentId } from '../../../utils/envelope';
import { jobs } from '../../client';
import type { JobRunIO } from '../../client/_internal/job';
import type { TSealDocumentSweepJobDefinition } from './seal-document-sweep';

export const run = async ({ io }: { payload: TSealDocumentSweepJobDefinition; io: JobRunIO }) => {
  const now = DateTime.now();
  const fifteenMinutesAgo = now.minus({ minutes: 15 }).toJSDate();
  const sixHoursAgo = now.minus({ hours: 6 }).toJSDate();

  // REVALLE: NF retida (todos assinaram) cujo pedido de aprovação ao Financeiro não saiu: pede de novo, sem selar. Elas
  // ficam fora da busca abaixo, então é aqui que o pedido perdido (ninguém no Financeiro, disparo que falhou) volta.
  try {
    const requested = await retryFinanceApprovalRequests();

    if (requested > 0) {
      io.logger.info(`Finance approval requested again for ${requested} held invoices`);
    }
  } catch (error) {
    io.logger.warn({ msg: 'revalle finance: falha ao pedir de novo as aprovações', error: String(error) });
  }

  // Find all PENDING envelopes that should have been sealed but weren't.
  //
  // A document is ready to seal when either:
  //   1. All recipients are SIGNED or have role CC (normal completion)
  //   2. Any recipient has REJECTED (rejection triggers immediate seal)
  //
  // We only look at documents where the last action was between 15 minutes
  // and 6 hours ago. The lower bound avoids racing with the normal seal-document
  // job that fires on completion. The upper bound stops us from endlessly retrying
  // documents that are stuck due to a deeper issue (e.g. corrupt PDF).
  const unsealedEnvelopes = await kyselyPrisma.$kysely
    .selectFrom('Envelope')
    .select(['Envelope.id', 'Envelope.secondaryId'])
    .where('Envelope.status', '=', sql.lit(DocumentStatus.PENDING))
    .where('Envelope.type', '=', sql.lit(EnvelopeType.DOCUMENT))
    .where('Envelope.deletedAt', 'is', null)
    // Ensure there is at least one recipient.
    .where((eb) => eb.exists(eb.selectFrom('Recipient').whereRef('Recipient.envelopeId', '=', 'Envelope.id')))
    // Document is ready to seal: all recipients are SIGNED/CC, or any recipient REJECTED.
    .where((eb) =>
      eb.or([
        // Case 1: All recipients are either SIGNED or CC.
        eb.not(
          eb.exists(
            eb
              .selectFrom('Recipient')
              .whereRef('Recipient.envelopeId', '=', 'Envelope.id')
              .where('Recipient.signingStatus', '!=', sql.lit(SigningStatus.SIGNED))
              .where('Recipient.role', '!=', sql.lit(RecipientRole.CC)),
          ),
        ),
        // Case 2: Any recipient has rejected.
        eb.exists(
          eb
            .selectFrom('Recipient')
            .whereRef('Recipient.envelopeId', '=', 'Envelope.id')
            .where('Recipient.signingStatus', '=', sql.lit(SigningStatus.REJECTED)),
        ),
      ]),
    )
    // REVALLE: início. A aprovação do Financeiro também é atividade do documento:
    //   - NF retida (`PENDING_APPROVAL`) ou versão substituída (`SUPERSEDED`) nunca entra, salvo se alguém recusou
    //     (recusa sela como no upstream); assim elas não ocupam o `limit` (o guard no laço continua como reserva);
    //   - aprovada há menos de 15 minutos: não corre com a selagem que a própria aprovação disparou;
    //   - a janela de 6 horas conta também da aprovação (aprovar dias depois da última assinatura e a selagem falhar).
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('RevalleInvoiceClassification')
            .whereRef('RevalleInvoiceClassification.envelopeId', '=', 'Envelope.id')
            .where('RevalleInvoiceClassification.isInvoice', '=', sql.lit(RevalleInvoiceStatus.YES))
            .where('RevalleInvoiceClassification.financeStatus', 'in', [
              sql.lit(RevalleFinanceStatus.PENDING_APPROVAL),
              sql.lit(RevalleFinanceStatus.SUPERSEDED),
            ])
            .where((inner) =>
              inner.not(
                inner.exists(
                  inner
                    .selectFrom('Recipient')
                    .whereRef('Recipient.envelopeId', '=', 'Envelope.id')
                    .where('Recipient.signingStatus', '=', sql.lit(SigningStatus.REJECTED)),
                ),
              ),
            ),
        ),
      ),
    )
    // Exclude envelopes where a recipient signed/rejected (or finance approved) within the last 15 minutes
    // to avoid racing with the standard completion flow.
    .where((eb) =>
      eb.not(
        eb.or([
          eb.exists(
            eb
              .selectFrom('Recipient')
              .whereRef('Recipient.envelopeId', '=', 'Envelope.id')
              .where('Recipient.signedAt', '>', fifteenMinutesAgo),
          ),
          eb.exists(
            eb
              .selectFrom('RevalleInvoiceClassification')
              .whereRef('RevalleInvoiceClassification.envelopeId', '=', 'Envelope.id')
              .where('RevalleInvoiceClassification.approvedAt', '>', fifteenMinutesAgo),
          ),
        ]),
      ),
    )
    // Exclude envelopes where all activity (signatures or finance approval) is older than 6 hours.
    // These are likely stuck due to a deeper issue and should not be retried.
    .where((eb) =>
      eb.or([
        eb.exists(
          eb
            .selectFrom('Recipient')
            .whereRef('Recipient.envelopeId', '=', 'Envelope.id')
            .where('Recipient.signedAt', '>', sixHoursAgo),
        ),
        eb.exists(
          eb
            .selectFrom('RevalleInvoiceClassification')
            .whereRef('RevalleInvoiceClassification.envelopeId', '=', 'Envelope.id')
            .where('RevalleInvoiceClassification.approvedAt', '>', sixHoursAgo),
        ),
      ]),
    )
    // REVALLE: fim.
    .limit(100)
    .execute();

  if (unsealedEnvelopes.length === 0) {
    io.logger.info('No unsealed documents found');
    return;
  }

  io.logger.info(`Found ${unsealedEnvelopes.length} unsealed documents`);

  await Promise.allSettled(
    unsealedEnvelopes.map(async (envelope) => {
      const documentId = mapSecondaryIdToDocumentId(envelope.secondaryId);

      // REVALLE: NF assinada aguardando a aprovação do Financeiro fica retida (a aprovação dispara a selagem).
      if (await holdSealForFinance(envelope.id)) {
        io.logger.info(`Seal held for finance approval: document ${documentId} (${envelope.id})`);

        return;
      }

      io.logger.info(`Triggering seal for document ${documentId} (${envelope.id})`);

      await jobs.triggerJob({
        name: 'internal.seal-document',
        payload: {
          documentId,
          isResealing: true,
        },
      });
    }),
  );
};
