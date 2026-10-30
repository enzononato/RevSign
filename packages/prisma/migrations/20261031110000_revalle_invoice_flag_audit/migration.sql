-- REVALLE (Fase 5): quem trocou a marcação "é nota fiscal" e quando (spec §3).
-- AlterTable
ALTER TABLE "RevalleInvoiceClassification" ADD COLUMN     "flagChangedAt" TIMESTAMP(3),
ADD COLUMN     "flagChangedById" INTEGER;
