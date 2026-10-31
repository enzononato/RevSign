-- REVALLE: Fase 6, nome de quem do Financeiro aprovou (ou definiu) a conta, congelado na aprovação: o certificado e o
-- /verificar mostram o nome daquele momento, mesmo que a pessoa mude o nome depois. Nulo nas linhas aprovadas antes
-- desta coluna: elas usam o nome atual.

-- AlterTable
ALTER TABLE "RevalleInvoiceClassification" ADD COLUMN     "approvedByName" TEXT;
