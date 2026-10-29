-- AlterTable
ALTER TABLE "RevalleRecipientGate" ADD COLUMN "codeFailedAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "conflictCpf" TEXT;
