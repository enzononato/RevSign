-- REVALLE: histórico dos hashes finais. Cada selagem (inclusive reselagem) acrescenta uma linha; nada é sobrescrito.
-- CreateTable
CREATE TABLE "RevalleSealedHash" (
    "id" TEXT NOT NULL,
    "documentHashId" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sealedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevalleSealedHash_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RevalleSealedHash_documentHashId_idx" ON "RevalleSealedHash"("documentHashId");

-- AddForeignKey
ALTER TABLE "RevalleSealedHash" ADD CONSTRAINT "RevalleSealedHash_documentHashId_fkey" FOREIGN KEY ("documentHashId") REFERENCES "RevalleDocumentHash"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: a versão selada atual de cada documento vira a primeira linha do histórico.
INSERT INTO "RevalleSealedHash" ("id", "documentHashId", "sha256", "sealedAt")
SELECT gen_random_uuid()::text, "id", "finalSha256", COALESCE("sealedAt", "sentAt")
FROM "RevalleDocumentHash"
WHERE "finalSha256" IS NOT NULL;
