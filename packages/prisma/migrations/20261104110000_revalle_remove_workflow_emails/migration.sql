-- REVALLE: Fase 7, sem e-mail de fluxo: saem o PDF para a contabilidade (o endereço e a marca de envio) e o pedido
-- "aguardando aprovação do Financeiro" (a marca do e-mail). O Financeiro e a Contabilidade acham as notas na página
-- Notas fiscais.

-- AlterTable
ALTER TABLE "RevalleInvoiceClassification" DROP COLUMN "accountingEmailSentAt",
DROP COLUMN "approvalRequestedAt";

-- AlterTable
ALTER TABLE "RevalleAccountingSettings" DROP COLUMN "accountingEmail";
