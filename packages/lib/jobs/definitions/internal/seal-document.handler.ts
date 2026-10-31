import path from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { finalizeTspEnvelopeCompletion } from '@documenso/ee/server-only/signing/csc/finalize-tsp-completion';
import { addRejectionStampToPdf } from '@documenso/lib/server-only/pdf/add-rejection-stamp-to-pdf';
import { generateAuditLogPdf } from '@documenso/lib/server-only/pdf/generate-audit-log-pdf';
import { generateCertificatePdf } from '@documenso/lib/server-only/pdf/generate-certificate-pdf';
import { getLastPageDimensions } from '@documenso/lib/server-only/pdf/get-page-size';
import { prisma } from '@documenso/prisma';
import { signPdf } from '@documenso/signing';
import { PDF } from '@libpdf/core';
import type { DocumentData, Envelope, EnvelopeItem, Field } from '@prisma/client';
import { DocumentStatus, EnvelopeType, RecipientRole, SigningStatus, WebhookTriggerEvents } from '@prisma/client';
import { nanoid } from 'nanoid';
import { groupBy } from 'remeda';

import { NEXT_PRIVATE_USE_PLAYWRIGHT_PDF } from '../../../constants/app';
import { AppError, AppErrorCode } from '../../../errors/app-error';
import { sha256Hex } from '../../../revalle/sha256'; // REVALLE:
import type { RevalleStamp } from '../../../revalle/stamp'; // REVALLE:
import { getAuditLogsPdf } from '../../../server-only/htmltopdf/get-audit-logs-pdf';
import { getCertificatePdf } from '../../../server-only/htmltopdf/get-certificate-pdf';
import { insertFieldInPDFV1 } from '../../../server-only/pdf/insert-field-in-pdf-v1';
import { insertFieldInPDFV2 } from '../../../server-only/pdf/insert-field-in-pdf-v2';
import { legacy_insertFieldInPDF } from '../../../server-only/pdf/legacy-insert-field-in-pdf';
import { recordFinalHash } from '../../../server-only/revalle/document-hashes'; // REVALLE:
import { holdSealForFinance, lockSupersededInvoiceForSealing } from '../../../server-only/revalle/finance/seal-hold'; // REVALLE:
import { shouldEmailInvoiceAccounting } from '../../../server-only/revalle/invoice/accounting-email'; // REVALLE:
import { loadRevalleStamps } from '../../../server-only/revalle/proof/load-stamps'; // REVALLE:
import { getTeamSettings } from '../../../server-only/team/get-team-settings';
import { triggerWebhook } from '../../../server-only/webhooks/trigger/trigger-webhook';
import { DOCUMENT_AUDIT_LOG_TYPE, type TDocumentAuditLog } from '../../../types/document-audit-logs';
import { isTspEnvelope } from '../../../types/signature-level';
import { mapEnvelopeToWebhookDocumentPayload, ZWebhookDocumentSchema } from '../../../types/webhook-payload';
import { prefixedId } from '../../../universal/id';
import { getFileServerSide } from '../../../universal/upload/get-file.server';
import { putPdfFileServerSide } from '../../../universal/upload/put-file.server';
import { fieldsContainUnsignedRequiredField } from '../../../utils/advanced-fields-helpers';
import { isDocumentCompleted } from '../../../utils/document';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { mapDocumentIdToSecondaryId } from '../../../utils/envelope';
import { jobs } from '../../client';
import type { JobRunIO } from '../../client/_internal/job';
import type { TSealDocumentJobDefinition } from './seal-document';

export const run = async ({ payload, io }: { payload: TSealDocumentJobDefinition; io: JobRunIO }) => {
  const { documentId, sendEmail = true, isResealing = false, requestMetadata } = payload;

  const revalleSealResult = await io.runTask('seal-document', async () => {
    const envelope = await prisma.envelope.findFirstOrThrow({
      where: {
        type: EnvelopeType.DOCUMENT,
        secondaryId: mapDocumentIdToSecondaryId(documentId),
      },
      include: {
        user: {
          select: {
            name: true,
            email: true,
          },
        },
        documentMeta: true,
        recipients: true,
        fields: {
          include: {
            signature: true,
          },
        },
        envelopeItems: {
          include: {
            documentData: true,
            field: {
              include: {
                signature: true,
              },
            },
          },
        },
      },
    });

    // REVALLE: dentro da tarefa (o resultado fica guardado por job): o retry do MESMO job depois de uma falha nos
    // passos seguintes (webhook, e-mails) recebe o resultado guardado e termina esses passos; só um job novo é pulado.
    //   - Disparo duplicado (aprovação e última assinatura ao mesmo tempo, varredura): documento já selado só é selado
    //     de novo pela reselagem (`isResealing`, que parte do PDF original); sem isso os campos seriam carimbados de novo.
    //   - Defesa em profundidade: nenhum caminho (reselagem pelo admin, varredura, disparo novo do upstream) sela NF
    //     aguardando a aprovação do Financeiro nem versão substituída. O job termina sem erro e o documento continua
    //     PENDING; a aprovação dispara a selagem.
    //   - Reselagem pelo admin de um documento já concluído (ex.: NF marcada depois da conclusão, ainda aguardando a
    //     aprovação) segue: ela só refaz o PDF de um documento concluído; a aprovação continua decidindo a contabilidade.
    if (!isResealing && (envelope.status === DocumentStatus.COMPLETED || envelope.status === DocumentStatus.REJECTED)) {
      io.logger.info(`Seal skipped, already sealed: document ${documentId} (${envelope.id})`);

      return { skipped: true as const };
    }

    const isResealingCompleted = isResealing && envelope.status === DocumentStatus.COMPLETED; // REVALLE:

    if (!isResealingCompleted && (await holdSealForFinance(envelope.id))) {
      io.logger.info(`Seal held for finance: document ${documentId} (${envelope.id})`);

      return { skipped: true as const };
    }

    if (envelope.envelopeItems.length === 0) {
      throw new Error('At least one envelope item required');
    }

    const settings = await getTeamSettings({
      userId: envelope.userId,
      teamId: envelope.teamId,
    });

    // Ensure all CC recipients are marked as signed
    await prisma.recipient.updateMany({
      where: {
        envelopeId: envelope.id,
        role: RecipientRole.CC,
      },
      data: {
        signingStatus: SigningStatus.SIGNED,
      },
    });

    const isComplete =
      envelope.recipients.some((recipient) => recipient.signingStatus === SigningStatus.REJECTED) ||
      envelope.recipients.every(
        (recipient) => recipient.signingStatus === SigningStatus.SIGNED || recipient.role === RecipientRole.CC,
      );

    if (!isComplete) {
      throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
        message: 'Document is not complete',
      });
    }

    let { envelopeItems } = envelope;

    const fields = envelope.fields;

    if (envelopeItems.length < 1) {
      throw new Error(`Document ${envelope.id} has no envelope items`);
    }

    const recipientsWithoutCCers = envelope.recipients.filter((recipient) => recipient.role !== RecipientRole.CC);

    // Determine if the document has been rejected by checking if any recipient has rejected it
    const rejectedRecipient = recipientsWithoutCCers.find(
      (recipient) => recipient.signingStatus === SigningStatus.REJECTED,
    );

    const isRejected = Boolean(rejectedRecipient);

    // Get the rejection reason from the rejected recipient
    const rejectionReason = rejectedRecipient?.rejectionReason ?? '';

    // Skip the field check if the document is rejected
    if (!isRejected && fieldsContainUnsignedRequiredField(fields)) {
      throw new Error(`Document ${envelope.id} has unsigned required fields`);
    }

    if (isResealing) {
      // If we're resealing we want to use the initial data for the document
      // so we aren't placing fields on top of eachother.
      envelopeItems = envelopeItems.map((envelopeItem) => ({
        ...envelopeItem,
        documentData: {
          ...envelopeItem.documentData,
          data: envelopeItem.documentData.initialData,
        },
      }));
    }

    if (!envelope.qrToken) {
      await prisma.envelope.update({
        where: {
          id: envelope.id,
        },
        data: {
          qrToken: prefixedId('qr'),
        },
      });
    }

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const envelopeCompletedAuditLog = createDocumentAuditLogData({
      type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_COMPLETED,
      envelopeId: envelope.id,
      requestMetadata,
      user: null,
      data: {
        transactionId: nanoid(),
        ...(isRejected ? { isRejected: true, rejectionReason: rejectionReason } : {}),
      },
    });

    const finalEnvelopeStatus = isRejected ? DocumentStatus.REJECTED : DocumentStatus.COMPLETED;

    if (isTspEnvelope(envelope)) {
      if (isResealing) {
        throw new AppError(AppErrorCode.NOT_SETUP, {
          message: 'Re-sealing TSP envelopes is not supported — recipient signatures cannot be regenerated externally.',
        });
      }

      if (isRejected) {
        throw new AppError(AppErrorCode.NOT_SETUP, {
          message:
            'TSP envelope rejection is not supported in V1 — rejection stamps would invalidate PAdES signatures.',
        });
      }

      await finalizeTspEnvelopeCompletion({
        envelope,
        envelopeCompletedAuditLog,
        requestMetadata,
      });

      return {
        envelopeId: envelope.id,
        envelopeStatus: envelope.status,
        isRejected,
      };
    }

    // Pre-fetch all PDF data so we can read dimensions and pass it
    // to decorateAndSignPdf without fetching again.
    const prefetchedItems = await Promise.all(
      envelopeItems.map(async (envelopeItem) => {
        const pdfData = await getFileServerSide(envelopeItem.documentData);

        return { envelopeItem, pdfData };
      }),
    );

    const usePlaywrightPdf = NEXT_PRIVATE_USE_PLAYWRIGHT_PDF();

    // REVALLE: carimbo de texto montado a partir da prova congelada de cada destinatário.
    const revalleStamps = await loadRevalleStamps(envelope.id);

    const needsCertificate = settings.includeSigningCertificate;
    const needsAuditLog = settings.includeAuditLog;

    const newDocumentData: Array<{
      oldDocumentDataId: string;
      newDocumentDataId: string;
      envelopeItemId: string; // REVALLE
      finalSha256: string; // REVALLE
    }> = [];

    for (const { envelopeItem, pdfData } of prefetchedItems) {
      const envelopeItemFields = envelope.envelopeItems.find((item) => item.id === envelopeItem.id)?.field;

      if (!envelopeItemFields) {
        throw new Error(`Envelope item fields not found for envelope item ${envelopeItem.id}`);
      }

      let certificateDoc: PDF | null = null;
      let auditLogDoc: PDF | null = null;

      if (needsCertificate || needsAuditLog) {
        const pdfDoc = await PDF.load(pdfData);

        const { width: pageWidth, height: pageHeight } = getLastPageDimensions(pdfDoc);

        const additionalAuditLogs = [
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          {
            ...envelopeCompletedAuditLog,
            id: '',
            createdAt: new Date(),
          } as TDocumentAuditLog,
        ];

        const certificatePayload = {
          envelope: {
            ...envelope,
            status: finalEnvelopeStatus,
          },
          recipients: envelope.recipients,
          fields,
          language: envelope.documentMeta.language,
          envelopeOwner: {
            email: envelope.user.email,
            name: envelope.user.name || '',
          },
          envelopeItems: envelopeItems.map((item) => item.title),
          pageWidth,
          pageHeight,
          additionalAuditLogs,
          revalleEnvelopeItemId: envelopeItem.id, // REVALLE: hash original deste item no cabeçalho do certificado
        };

        const makeCertificatePdf = async () =>
          usePlaywrightPdf
            ? getCertificatePdf({
                documentId,
                language: envelope.documentMeta.language,
              }).then(async (buffer) => PDF.load(buffer))
            : generateCertificatePdf(certificatePayload);

        const makeAuditLogPdf = async () =>
          usePlaywrightPdf
            ? getAuditLogsPdf({
                documentId,
                language: envelope.documentMeta.language,
              }).then(async (buffer) => PDF.load(buffer))
            : generateAuditLogPdf(certificatePayload);

        [certificateDoc, auditLogDoc] = await Promise.all([
          needsCertificate ? makeCertificatePdf() : null,
          needsAuditLog ? makeAuditLogPdf() : null,
        ]);
      }

      const result = await decorateAndSignPdf({
        envelope,
        envelopeItem,
        envelopeItemFields,
        isRejected,
        rejectionReason,
        pdfData,
        certificateDoc,
        auditLogDoc,
        revalleStamps, // REVALLE:
      });

      newDocumentData.push(result);
    }

    // REVALLE: `revalleCompleted` = false quando a NF foi substituída pelo Financeiro durante a selagem (nada gravado).
    const revalleCompleted = await prisma.$transaction(async (tx) => {
      // REVALLE: a troca de conta que chegou durante a selagem vence (linha da NF travada); recusa e reselagem de
      // versão já concluída seguem.
      if (
        !isRejected &&
        envelope.status !== DocumentStatus.COMPLETED &&
        (await lockSupersededInvoiceForSealing(tx, envelope.id))
      ) {
        return false;
      }

      for (const { oldDocumentDataId, newDocumentDataId, envelopeItemId, finalSha256 } of newDocumentData) {
        // REVALLE: SHA-256 dos bytes exatos assinados.
        await recordFinalHash(envelopeItemId, finalSha256, tx);

        await tx.envelopeItem.update({
          where: {
            envelopeId: envelope.id,
            documentDataId: oldDocumentDataId,
          },
          data: {
            documentDataId: newDocumentDataId,
          },
        });
      }

      await tx.envelope.update({
        where: {
          id: envelope.id,
        },
        data: {
          status: finalEnvelopeStatus,
          completedAt: new Date(),
        },
      });

      await tx.documentAuditLog.create({
        data: envelopeCompletedAuditLog,
      });

      return true; // REVALLE:
    });

    // REVALLE: substituída durante a selagem: termina como a selagem pulada (sem webhook nem e-mails).
    if (!revalleCompleted) {
      io.logger.info(`Seal aborted, superseded by finance: document ${documentId} (${envelope.id})`);

      // Os PDFs selados desta tentativa não foram ligados a nada: apagados para não ficarem órfãos no banco.
      await prisma.documentData
        .deleteMany({ where: { id: { in: newDocumentData.map((item) => item.newDocumentDataId) } } })
        .catch(() => undefined);

      return { skipped: true as const };
    }

    return {
      envelopeId: envelope.id,
      envelopeStatus: envelope.status,
      isRejected,
    };
  });

  // REVALLE: selagem pulada (já selado, retida ou substituída): nada de webhook nem e-mails.
  if ('skipped' in revalleSealResult) {
    return;
  }

  const { envelopeId, envelopeStatus, isRejected } = revalleSealResult; // REVALLE:

  const updatedEnvelope = await prisma.envelope.findFirstOrThrow({
    where: {
      id: envelopeId,
    },
    include: {
      documentMeta: true,
      recipients: true,
    },
  });

  await triggerWebhook({
    event: isRejected ? WebhookTriggerEvents.DOCUMENT_REJECTED : WebhookTriggerEvents.DOCUMENT_COMPLETED,
    data: ZWebhookDocumentSchema.parse(mapEnvelopeToWebhookDocumentPayload(updatedEnvelope)),
    userId: updatedEnvelope.userId,
    teamId: updatedEnvelope.teamId ?? undefined,
  });

  let shouldSendCompletedEmail = sendEmail && !isResealing && !isRejected;

  if (isResealing && !isDocumentCompleted(envelopeStatus)) {
    shouldSendCompletedEmail = sendEmail;
  }

  if (shouldSendCompletedEmail) {
    await jobs.triggerJob({
      name: 'send.document.completed.emails',
      payload: {
        envelopeId,
        requestMetadata,
      },
    });
  }

  // REVALLE: nota fiscal concluída: avisa a contabilidade. É um processo interno, independente de `sendEmail` e dos
  // e-mails dos participantes. Não vale para documento recusado nem para reselagem de documento já concluído; o job
  // ainda confere o status e reserva `accountingEmailSentAt`, então só envia uma vez. Uma falha aqui nunca derruba a selagem.
  if (!isRejected && !(isResealing && isDocumentCompleted(envelopeStatus))) {
    try {
      if (await shouldEmailInvoiceAccounting(envelopeId)) {
        await jobs.triggerJob({ name: 'send.revalle.invoice.accounting.email', payload: { envelopeId } });
      }
    } catch (error) {
      io.logger.error({
        msg: 'Falha ao agendar o e-mail da contabilidade',
        envelopeId,
        error: error instanceof Error ? error.message : 'erro desconhecido',
      });
    }
  }
};

type DecorateAndSignPdfOptions = {
  envelope: Pick<Envelope, 'id' | 'title' | 'useLegacyFieldInsertion' | 'internalVersion'>;
  envelopeItem: EnvelopeItem & { documentData: DocumentData };
  envelopeItemFields: Field[];
  isRejected: boolean;
  rejectionReason: string;
  pdfData: Uint8Array;
  certificateDoc: PDF | null;
  auditLogDoc: PDF | null;
  revalleStamps: Map<number, RevalleStamp>; // REVALLE:
};

/**
 * Normalize, flatten and insert fields into a PDF document.
 */
const decorateAndSignPdf = async ({
  envelope,
  envelopeItem,
  envelopeItemFields,
  isRejected,
  rejectionReason,
  pdfData,
  certificateDoc,
  auditLogDoc,
  revalleStamps, // REVALLE:
}: DecorateAndSignPdfOptions) => {
  let pdfDoc = await PDF.load(pdfData);

  // Normalize and flatten layers that could cause issues with the signature
  pdfDoc.flattenAll();
  // Upgrade to PDF 1.7 for better compatibility with signing
  pdfDoc.upgradeVersion('1.7');

  // Add rejection stamp if the document is rejected
  if (isRejected) {
    await addRejectionStampToPdf(pdfDoc, rejectionReason);
  }

  if (certificateDoc) {
    await pdfDoc.copyPagesFrom(
      certificateDoc,
      Array.from({ length: certificateDoc.getPageCount() }, (_, index) => index),
    );
  }

  if (auditLogDoc) {
    await pdfDoc.copyPagesFrom(
      auditLogDoc,
      Array.from({ length: auditLogDoc.getPageCount() }, (_, index) => index),
    );
  }

  // Handle V1 and legacy insertions.
  if (envelope.internalVersion === 1) {
    const legacy_pdfLibDoc = await PDFDocument.load(await pdfDoc.save({ useXRefStream: true }));

    for (const field of envelopeItemFields) {
      if (field.inserted) {
        // REVALLE: com prova, o carimbo sai sempre (inclusive em envelope com inserção legada).
        const revalleStamp = field.type === 'SIGNATURE' ? revalleStamps.get(field.recipientId) : undefined;

        if (envelope.useLegacyFieldInsertion && !revalleStamp) {
          await legacy_insertFieldInPDF(legacy_pdfLibDoc, field);
        } else {
          await insertFieldInPDFV1(legacy_pdfLibDoc, field, revalleStamp);
        }
      }
    }

    // Should never run into issues with this flatten since all
    // arcoFields are created by pdf-lib itself.
    legacy_pdfLibDoc.getForm().flatten();

    await pdfDoc.reload(await legacy_pdfLibDoc.save());
  }

  // Handle V2 envelope insertions.
  if (envelope.internalVersion === 2) {
    const fieldsGroupedByPage = groupBy(envelopeItemFields, (field) => field.page);

    for (const [pageNumber, fields] of Object.entries(fieldsGroupedByPage)) {
      const page = pdfDoc.getPage(Number(pageNumber) - 1);

      if (!page) {
        throw new Error(`Page ${pageNumber} does not exist`);
      }

      const pageWidth = page.width;
      const pageHeight = page.height;

      const overlayBytes = await insertFieldInPDFV2({
        pageWidth,
        pageHeight,
        fields,
        revalleStamps, // REVALLE:
      });

      const overlayPdf = await PDF.load(overlayBytes);

      const embeddedPage = await pdfDoc.embedPage(overlayPdf, 0);

      // Rotate the page to the orientation that the react-pdf renders on the frontend.
      let translateX = 0;
      let translateY = 0;

      switch (page.rotation) {
        case 90:
          translateX = pageHeight;
          translateY = 0;
          break;
        case 180:
          translateX = pageWidth;
          translateY = pageHeight;
          break;
        case 270:
          translateX = 0;
          translateY = pageWidth;
          break;
      }

      // Draw the overlay on the page
      page.drawPage(embeddedPage, {
        x: translateX,
        y: translateY,
        rotate: {
          angle: page.rotation,
        },
      });
    }
  }

  // Re-flatten the form to handle our checkbox and radio fields that
  // create native arcoFields
  pdfDoc.flattenAll();

  pdfDoc = await PDF.load(await pdfDoc.save({ useXRefStream: true }));

  const pdfBytes = await signPdf({ pdf: pdfDoc });

  const { name } = path.parse(envelopeItem.title);

  // Add suffix based on document status
  const suffix = isRejected ? '_rejected.pdf' : '_signed.pdf';

  const { documentData: newDocumentData } = await putPdfFileServerSide(
    {
      name: `${name}${suffix}`,
      type: 'application/pdf',
      arrayBuffer: async () => Promise.resolve(pdfBytes),
    },
    envelopeItem.documentData.initialData,
  );

  return {
    oldDocumentDataId: envelopeItem.documentData.id,
    newDocumentDataId: newDocumentData.id,
    envelopeItemId: envelopeItem.id, // REVALLE
    finalSha256: sha256Hex(pdfBytes), // REVALLE
  };
};
