-- CreateTable
CREATE TABLE "RevalleEmailLink" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "cpf" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByRecipientId" INTEGER,

    CONSTRAINT "RevalleEmailLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevalleRecipientGate" (
    "id" TEXT NOT NULL,
    "recipientId" INTEGER NOT NULL,
    "termVersion" TEXT,
    "termAcceptedAt" TIMESTAMP(3),
    "termIpAddress" TEXT,
    "termUserAgent" TEXT,
    "identityStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "pendingCpf" TEXT,
    "cpf" TEXT,
    "identityConfirmedAt" TIMESTAMP(3),
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "lockReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevalleRecipientGate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RevalleEmailLink_email_key" ON "RevalleEmailLink"("email");

-- CreateIndex
CREATE INDEX "RevalleEmailLink_cpf_idx" ON "RevalleEmailLink"("cpf");

-- CreateIndex
CREATE UNIQUE INDEX "RevalleRecipientGate_recipientId_key" ON "RevalleRecipientGate"("recipientId");

-- AddForeignKey
ALTER TABLE "RevalleRecipientGate" ADD CONSTRAINT "RevalleRecipientGate_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Recipient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

