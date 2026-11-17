-- REVALLE: conta e centro no PDF só onde o remetente põe o bloco "Conta e centro de custo" (um por arquivo, em
-- `RevalleInvoiceAnnotationBox`). `RevalleInvoiceClassification.autoAnnotation` marca o envio de antes desta versão: a
-- selagem continua escrevendo o texto sozinha, acima da primeira assinatura de cada nota. Só acrescenta.
--
-- A marca (entre `-- backfill:inicio` e `-- backfill:fim`, que os testes rodam de novo dentro de uma transação desfeita)
-- vale para o envio que já saiu do rascunho e para a nova versão em rascunho que já existe (tem versão anterior). O
-- rascunho comum, nunca enviado, segue a regra nova.

-- AlterTable
ALTER TABLE "RevalleInvoiceClassification" ADD COLUMN     "autoAnnotation" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "RevalleInvoiceAnnotationBox" (
    "envelopeItemId" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "page" INTEGER NOT NULL,
    "positionX" DOUBLE PRECISION NOT NULL,
    "positionY" DOUBLE PRECISION NOT NULL,
    "width" DOUBLE PRECISION NOT NULL,
    "height" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevalleInvoiceAnnotationBox_pkey" PRIMARY KEY ("envelopeItemId")
);

-- CreateIndex
CREATE INDEX "RevalleInvoiceAnnotationBox_envelopeId_idx" ON "RevalleInvoiceAnnotationBox"("envelopeId");

-- AddForeignKey
ALTER TABLE "RevalleInvoiceAnnotationBox" ADD CONSTRAINT "RevalleInvoiceAnnotationBox_envelopeItemId_fkey" FOREIGN KEY ("envelopeItemId") REFERENCES "EnvelopeItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevalleInvoiceAnnotationBox" ADD CONSTRAINT "RevalleInvoiceAnnotationBox_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "Envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- backfill:inicio
UPDATE "RevalleInvoiceClassification" c
SET "autoAnnotation" = true
FROM "Envelope" e
WHERE e."id" = c."envelopeId"
  AND (e."status" <> 'DRAFT' OR c."previousEnvelopeId" IS NOT NULL);
-- backfill:fim
