-- REVALLE: Fase 6, selagem retida até o Financeiro aprovar: marca do e-mail "Nota fiscal aguardando aprovação do
-- Financeiro" (um por retenção).

-- AlterTable
ALTER TABLE "RevalleInvoiceClassification" ADD COLUMN     "approvalRequestedAt" TIMESTAMP(3);
