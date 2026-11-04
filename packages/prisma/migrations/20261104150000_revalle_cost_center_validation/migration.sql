-- REVALLE: Fase 7, a Contabilidade valida o centro de custo (quem e quando, com o nome congelado) e a marca de versão
-- substituída passa a dizer o que mudou. Toda versão já substituída veio de uma troca de conta.

-- CreateEnum
CREATE TYPE "RevalleSupersedeKind" AS ENUM ('ACCOUNT', 'COST_CENTER');

-- AlterTable
ALTER TABLE "RevalleInvoiceClassification" ADD COLUMN     "costCenterValidatedAt" TIMESTAMP(3),
ADD COLUMN     "costCenterValidatedById" INTEGER,
ADD COLUMN     "costCenterValidatedByName" TEXT,
ADD COLUMN     "supersedeKind" "RevalleSupersedeKind";

-- Linhas já substituídas
UPDATE "RevalleInvoiceClassification" SET "supersedeKind" = 'ACCOUNT' WHERE "financeStatus" = 'SUPERSEDED';
