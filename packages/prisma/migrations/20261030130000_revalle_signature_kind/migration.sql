-- AlterTable
ALTER TABLE "RevalleSignatureProof" ADD COLUMN "signatureKind" TEXT NOT NULL DEFAULT 'NONE';
UPDATE "RevalleSignatureProof" SET "signatureKind" = CASE WHEN "drewSignature" THEN 'IMAGE' ELSE 'NONE' END;
ALTER TABLE "RevalleSignatureProof" ALTER COLUMN "signatureKind" DROP DEFAULT;
