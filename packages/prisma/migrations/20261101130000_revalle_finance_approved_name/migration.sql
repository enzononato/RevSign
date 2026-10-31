-- REVALLE: Fase 6, nome da conta contábil congelado no momento da aprovação pelo Financeiro (o certificado e o
-- /verificar mostram o nome aprovado, mesmo que a lista de contas seja reimportada com outro nome depois). Nulo nas
-- linhas aprovadas antes desta coluna: elas usam o nome atual da lista.

-- AlterTable
ALTER TABLE "RevalleInvoiceClassification" ADD COLUMN     "approvedAccountName" TEXT;
