-- REVALLE: Fase 6, aprovação do Financeiro para notas fiscais.

-- CreateEnum
CREATE TYPE "RevalleFinanceStatus" AS ENUM ('AWAITING_ACCOUNT', 'PENDING_APPROVAL', 'APPROVED', 'SUPERSEDED', 'LEGACY');

-- AlterTable
ALTER TABLE "RevalleInvoiceClassification" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" INTEGER,
ADD COLUMN     "financeStatus" "RevalleFinanceStatus",
ADD COLUMN     "previousEnvelopeId" TEXT,
ADD COLUMN     "supersedeReason" TEXT,
ADD COLUMN     "supersededAt" TIMESTAMP(3),
ADD COLUMN     "supersededByEnvelopeId" TEXT,
ADD COLUMN     "supersededById" INTEGER,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "RevalleFinanceMember" (
    "userId" INTEGER NOT NULL,
    "addedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevalleFinanceMember_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "RevalleFinanceMember" ADD CONSTRAINT "RevalleFinanceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: NFs que já existiam não exigem aprovação do Financeiro (spec da Fase 6, §1 "Fora do escopo").
UPDATE "RevalleInvoiceClassification" SET "financeStatus" = 'LEGACY' WHERE "isInvoice" = 'YES';
