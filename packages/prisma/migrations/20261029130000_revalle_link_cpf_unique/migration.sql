-- DropIndex
DROP INDEX "RevalleEmailLink_cpf_idx";

-- CreateIndex
CREATE UNIQUE INDEX "RevalleEmailLink_cpf_key" ON "RevalleEmailLink"("cpf");

-- AlterTable
ALTER TABLE "RevalleRecipientGate" ADD COLUMN "email" TEXT;
