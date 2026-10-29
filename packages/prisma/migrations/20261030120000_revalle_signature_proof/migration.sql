CREATE TABLE "RevalleSignatureProof" (
    "id" TEXT NOT NULL,
    "recipientId" INTEGER NOT NULL,
    "verificationCode" TEXT NOT NULL,
    "signedAt" TIMESTAMP(3) NOT NULL,
    "employee" JSONB,
    "identityVerified" BOOLEAN NOT NULL,
    "factors" JSONB NOT NULL,
    "termVersion" TEXT,
    "termAcceptedAt" TIMESTAMP(3),
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "device" TEXT,
    "ipLocation" JSONB,
    "deviceLocation" JSONB NOT NULL,
    "drewSignature" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevalleSignatureProof_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RevalleSignatureProof_recipientId_key" ON "RevalleSignatureProof"("recipientId");

-- CreateIndex
CREATE UNIQUE INDEX "RevalleSignatureProof_verificationCode_key" ON "RevalleSignatureProof"("verificationCode");

-- AddForeignKey
ALTER TABLE "RevalleSignatureProof" ADD CONSTRAINT "RevalleSignatureProof_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Recipient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

