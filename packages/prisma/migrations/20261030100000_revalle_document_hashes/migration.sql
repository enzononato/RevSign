-- CreateTable
CREATE TABLE "RevalleDocumentHash" (
    "id" TEXT NOT NULL,
    "envelopeItemId" TEXT NOT NULL,
    "originalSha256" TEXT NOT NULL,
    "finalSha256" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sealedAt" TIMESTAMP(3),

    CONSTRAINT "RevalleDocumentHash_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RevalleDocumentHash_envelopeItemId_key" ON "RevalleDocumentHash"("envelopeItemId");

-- AddForeignKey
ALTER TABLE "RevalleDocumentHash" ADD CONSTRAINT "RevalleDocumentHash_envelopeItemId_fkey" FOREIGN KEY ("envelopeItemId") REFERENCES "EnvelopeItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

