-- CreateEnum
CREATE TYPE "RevalleAccountKind" AS ENUM ('PAYABLE', 'RECEIVABLE');

-- CreateEnum
CREATE TYPE "RevalleInvoiceStatus" AS ENUM ('YES', 'NO', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "RevalleInvoiceDetectedBy" AS ENUM ('TEXT', 'SENDER');

-- CreateEnum
CREATE TYPE "RevalleSuggestionStatus" AS ENUM ('PENDING', 'DONE', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "RevalleAccountingAccount" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "kind" "RevalleAccountKind",
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevalleAccountingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevalleAccountingSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "prompt" TEXT NOT NULL DEFAULT '',
    "accountingEmail" TEXT,
    "updatedById" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevalleAccountingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevalleInvoiceClassification" (
    "envelopeId" TEXT NOT NULL,
    "isInvoice" "RevalleInvoiceStatus" NOT NULL,
    "detectedBy" "RevalleInvoiceDetectedBy" NOT NULL,
    "signals" TEXT[],
    "fileSha256" TEXT,
    "suggestionStatus" "RevalleSuggestionStatus" NOT NULL DEFAULT 'SKIPPED',
    "suggestion" JSONB,
    "suggestionAttempts" INTEGER NOT NULL DEFAULT 0,
    "choiceCode" TEXT,
    "choiceDefer" BOOLEAN NOT NULL DEFAULT false,
    "choiceById" INTEGER,
    "choiceAt" TIMESTAMP(3),
    "acceptedSuggestion" BOOLEAN,
    "accountingEmailSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevalleInvoiceClassification_pkey" PRIMARY KEY ("envelopeId")
);

-- CreateTable
CREATE TABLE "RevalleInvoiceSuggestionCache" (
    "fileSha256" TEXT NOT NULL,
    "suggestion" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevalleInvoiceSuggestionCache_pkey" PRIMARY KEY ("fileSha256")
);

-- CreateIndex
CREATE UNIQUE INDEX "RevalleAccountingAccount_code_key" ON "RevalleAccountingAccount"("code");

-- CreateIndex
CREATE INDEX "RevalleAccountingAccount_active_idx" ON "RevalleAccountingAccount"("active");

-- AddForeignKey
ALTER TABLE "RevalleInvoiceClassification" ADD CONSTRAINT "RevalleInvoiceClassification_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "Envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

