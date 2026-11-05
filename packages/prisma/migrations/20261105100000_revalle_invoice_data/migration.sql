-- REVALLE: Fase 8, fornecedor, número e valor da NF lidos pela IA junto com a sugestão de conta. O valor fica em
-- centavos. Linhas já existentes ficam sem os dados (nulos): a sugestão guardada de antes não os tem.

-- AlterTable
ALTER TABLE "RevalleInvoiceClassification" ADD COLUMN     "invoiceNumber" TEXT,
ADD COLUMN     "supplierName" TEXT,
ADD COLUMN     "totalAmountCents" INTEGER;
