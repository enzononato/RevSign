-- REVALLE: Fase 9, várias notas fiscais (e boletos) no mesmo envio. `RevalleInvoiceFile` guarda uma linha por arquivo do
-- envio (NF, boleto, outro ou sem texto) e passa a ser a fonte de verdade de tudo que é "da nota"; as colunas "da nota" de
-- `RevalleInvoiceClassification` ficam como espelho (cópia da nota única). `RevalleBoletoCache` guarda o que a IA leu de
-- cada boleto. Três colunas novas, nulas: `invoiceShown` (portão), `invoiceDocuments` (prova) e
-- `supersededEnvelopeItemId` (versão substituída). Só acrescenta: nada é apagado nem renomeado.
--
-- O backfill (entre as marcas `backfill:inicio` e `backfill:fim`, que os testes rodam de novo) cria a linha NF de cada NF
-- de envelope com um arquivo só, copiando da classificação. É idempotente (`ON CONFLICT DO NOTHING`). O envio já enviado
-- com 2+ arquivos é refeito pelo app, que acha pelo texto qual arquivo é a NF.

-- CreateEnum
CREATE TYPE "RevalleInvoiceFileKind" AS ENUM ('NF', 'BOLETO', 'OTHER', 'UNKNOWN');

-- AlterTable
ALTER TABLE "RevalleInvoiceClassification" ADD COLUMN     "supersededEnvelopeItemId" TEXT;

-- AlterTable
ALTER TABLE "RevalleRecipientGate" ADD COLUMN     "invoiceShown" JSONB;

-- AlterTable
ALTER TABLE "RevalleSignatureProof" ADD COLUMN     "invoiceDocuments" JSONB;

-- CreateTable
CREATE TABLE "RevalleInvoiceFile" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "envelopeItemId" TEXT NOT NULL,
    "kind" "RevalleInvoiceFileKind" NOT NULL,
    "detectedBy" "RevalleInvoiceDetectedBy" NOT NULL DEFAULT 'TEXT',
    "kindChangedById" INTEGER,
    "kindChangedAt" TIMESTAMP(3),
    "signals" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "fileSha256" TEXT,
    "suggestionStatus" "RevalleSuggestionStatus" NOT NULL DEFAULT 'SKIPPED',
    "suggestion" JSONB,
    "suggestionAttempts" INTEGER NOT NULL DEFAULT 0,
    "supplierName" TEXT,
    "invoiceNumber" TEXT,
    "totalAmountCents" INTEGER,
    "accessKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "boletoData" JSONB,
    "choiceCode" TEXT,
    "choiceById" INTEGER,
    "choiceAt" TIMESTAMP(3),
    "acceptedSuggestion" BOOLEAN,
    "costCenterCode" TEXT,
    "costCenterById" INTEGER,
    "costCenterAt" TIMESTAMP(3),
    "costCenterValidatedAt" TIMESTAMP(3),
    "costCenterValidatedById" INTEGER,
    "costCenterValidatedByName" TEXT,
    "approvedById" INTEGER,
    "approvedAt" TIMESTAMP(3),
    "approvedAccountName" TEXT,
    "approvedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevalleInvoiceFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevalleBoletoCache" (
    "fileSha256" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevalleBoletoCache_pkey" PRIMARY KEY ("fileSha256")
);

-- CreateIndex
CREATE UNIQUE INDEX "RevalleInvoiceFile_envelopeItemId_key" ON "RevalleInvoiceFile"("envelopeItemId");

-- CreateIndex
CREATE INDEX "RevalleInvoiceFile_envelopeId_idx" ON "RevalleInvoiceFile"("envelopeId");

-- CreateIndex
CREATE INDEX "RevalleInvoiceFile_accessKeys_idx" ON "RevalleInvoiceFile" USING GIN ("accessKeys");

-- CreateIndex
CREATE INDEX "RevalleInvoiceFile_fileSha256_idx" ON "RevalleInvoiceFile"("fileSha256");

-- AddForeignKey
ALTER TABLE "RevalleInvoiceFile" ADD CONSTRAINT "RevalleInvoiceFile_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "Envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevalleInvoiceFile" ADD CONSTRAINT "RevalleInvoiceFile_envelopeItemId_fkey" FOREIGN KEY ("envelopeItemId") REFERENCES "EnvelopeItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: a linha NF de cada NF de envelope com um arquivo só. Com um arquivo, a chave do conjunto é o próprio arquivo:
-- o hash do envio (`RevalleDocumentHash`) quando já foi enviado, senão o da classificação (rascunho).
-- backfill:inicio
INSERT INTO "RevalleInvoiceFile" (
    "id", "envelopeId", "envelopeItemId", "kind", "detectedBy", "kindChangedById", "kindChangedAt", "signals",
    "fileSha256", "suggestionStatus", "suggestion", "suggestionAttempts", "supplierName", "invoiceNumber",
    "totalAmountCents", "accessKeys", "choiceCode", "choiceById", "choiceAt", "acceptedSuggestion", "costCenterCode",
    "costCenterById", "costCenterAt", "costCenterValidatedAt", "costCenterValidatedById", "costCenterValidatedByName",
    "approvedById", "approvedAt", "approvedAccountName", "approvedByName", "createdAt", "updatedAt"
)
SELECT
    gen_random_uuid()::text, c."envelopeId", i."id", 'NF', c."detectedBy", c."flagChangedById", c."flagChangedAt",
    coalesce(c."signals", ARRAY[]::TEXT[]), coalesce(h."originalSha256", c."fileSha256"), c."suggestionStatus",
    c."suggestion", c."suggestionAttempts", c."supplierName", c."invoiceNumber", c."totalAmountCents",
    coalesce(c."accessKeys", ARRAY[]::TEXT[]), c."choiceCode", c."choiceById", c."choiceAt", c."acceptedSuggestion",
    c."costCenterCode", c."costCenterById", c."costCenterAt", c."costCenterValidatedAt", c."costCenterValidatedById",
    c."costCenterValidatedByName", c."approvedById", c."approvedAt", c."approvedAccountName", c."approvedByName",
    c."createdAt", CURRENT_TIMESTAMP
FROM "RevalleInvoiceClassification" c
JOIN "EnvelopeItem" i ON i."envelopeId" = c."envelopeId"
LEFT JOIN "RevalleDocumentHash" h ON h."envelopeItemId" = i."id"
WHERE c."isInvoice" = 'YES'
  AND (SELECT count(*) FROM "EnvelopeItem" x WHERE x."envelopeId" = c."envelopeId") = 1
ON CONFLICT ("envelopeItemId") DO NOTHING;
-- backfill:fim
