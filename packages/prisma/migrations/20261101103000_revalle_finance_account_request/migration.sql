-- REVALLE: Fase 6, "Deixar para o Financeiro": marca do e-mail "Nota fiscal aguardando o Financeiro" (um por retenção).

-- AlterTable
ALTER TABLE "RevalleInvoiceClassification" ADD COLUMN     "accountRequestedAt" TIMESTAMP(3);
