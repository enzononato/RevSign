-- REVALLE (v.21): contrato para colaboradores. O modelo marcado (`RevalleCollaboratorContract`), cada planilha enviada
-- (`RevalleBulkSendUpload`, com o ponto em que o job parou) e a fila de envio em lotes (`RevalleBulkSendQueue`, que é
-- também a marca "sem conta" de cada documento criado). Só acrescenta.

-- CreateEnum
CREATE TYPE "RevalleBulkSendStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "RevalleCollaboratorContract" (
    "id" TEXT NOT NULL,
    "templateEnvelopeId" TEXT,
    "sourceEnvelopeId" TEXT NOT NULL,
    "sourceVerificationCode" TEXT NOT NULL,
    "representativeName" TEXT NOT NULL,
    "representativeSignedAt" TIMESTAMP(3) NOT NULL,
    "createdById" INTEGER NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevalleCollaboratorContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevalleBulkSendUpload" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "createdById" INTEGER NOT NULL,
    "rows" JSONB NOT NULL,
    "totalRows" INTEGER NOT NULL,
    "duplicateRows" INTEGER NOT NULL,
    "processedRows" INTEGER NOT NULL DEFAULT 0,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevalleBulkSendUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevalleBulkSendQueue" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "status" "RevalleBulkSendStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "lockedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevalleBulkSendQueue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RevalleCollaboratorContract_templateEnvelopeId_key" ON "RevalleCollaboratorContract"("templateEnvelopeId");

-- CreateIndex
CREATE INDEX "RevalleCollaboratorContract_sourceEnvelopeId_idx" ON "RevalleCollaboratorContract"("sourceEnvelopeId");

-- CreateIndex
CREATE INDEX "RevalleBulkSendUpload_contractId_idx" ON "RevalleBulkSendUpload"("contractId");

-- CreateIndex
CREATE INDEX "RevalleBulkSendUpload_completedAt_updatedAt_idx" ON "RevalleBulkSendUpload"("completedAt", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RevalleBulkSendQueue_envelopeId_key" ON "RevalleBulkSendQueue"("envelopeId");

-- CreateIndex
CREATE INDEX "RevalleBulkSendQueue_contractId_status_idx" ON "RevalleBulkSendQueue"("contractId", "status");

-- CreateIndex
CREATE INDEX "RevalleBulkSendQueue_status_createdAt_idx" ON "RevalleBulkSendQueue"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "RevalleCollaboratorContract" ADD CONSTRAINT "RevalleCollaboratorContract_templateEnvelopeId_fkey" FOREIGN KEY ("templateEnvelopeId") REFERENCES "Envelope"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevalleBulkSendUpload" ADD CONSTRAINT "RevalleBulkSendUpload_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "RevalleCollaboratorContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevalleBulkSendQueue" ADD CONSTRAINT "RevalleBulkSendQueue_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "Envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevalleBulkSendQueue" ADD CONSTRAINT "RevalleBulkSendQueue_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "RevalleCollaboratorContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

