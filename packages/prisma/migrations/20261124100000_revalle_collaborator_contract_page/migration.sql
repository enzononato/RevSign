-- REVALLE (v.22): contrato para colaboradores pela página própria. O contrato nasce do assistente (rascunho), espera o
-- representante assinar e só então ganha a origem, o código e o modelo; por isso os campos da v.21 que vinham do
-- documento do representante passam a aceitar vazio. A fila ganha o CPF da lista (o portão só aceita esse CPF), o nome e
-- o último reenvio. Os contratos da v.21 ficam como SENDING.

-- CreateEnum
CREATE TYPE "RevalleCollaboratorContractStatus" AS ENUM ('DRAFT', 'AWAITING_REPRESENTATIVE', 'SENDING', 'PAUSED', 'COMPLETED', 'REJECTED_BY_REPRESENTATIVE');

-- AlterTable
ALTER TABLE "RevalleCollaboratorContract"
    ALTER COLUMN "sourceEnvelopeId" DROP NOT NULL,
    ALTER COLUMN "sourceVerificationCode" DROP NOT NULL,
    ALTER COLUMN "representativeName" DROP NOT NULL,
    ALTER COLUMN "representativeSignedAt" DROP NOT NULL,
    ADD COLUMN "title" TEXT,
    ADD COLUMN "status" "RevalleCollaboratorContractStatus" NOT NULL DEFAULT 'SENDING',
    ADD COLUMN "senderName" TEXT,
    ADD COLUMN "teamId" INTEGER,
    ADD COLUMN "representativeEnvelopeId" TEXT,
    ADD COLUMN "representativeEmail" TEXT,
    ADD COLUMN "representativeRect" JSONB,
    ADD COLUMN "collaboratorRect" JSONB,
    ADD COLUMN "sourcePdfDocumentDataId" TEXT;

-- Os contratos existentes (v.21) ficaram como SENDING pelo default acima; os novos nascem como rascunho.
ALTER TABLE "RevalleCollaboratorContract" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

-- AlterTable
ALTER TABLE "RevalleBulkSendQueue"
    ADD COLUMN "cpf" TEXT,
    ADD COLUMN "name" TEXT,
    ADD COLUMN "resentAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "RevalleCollaboratorContract_representativeEnvelopeId_key" ON "RevalleCollaboratorContract"("representativeEnvelopeId");

-- CreateIndex
CREATE INDEX "RevalleCollaboratorContract_status_idx" ON "RevalleCollaboratorContract"("status");
