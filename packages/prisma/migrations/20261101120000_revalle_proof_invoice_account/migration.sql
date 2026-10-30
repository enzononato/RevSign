-- REVALLE: Fase 6, a conta contábil faz parte do que é assinado: { code, name } da conta escolhida da NF no momento da
-- assinatura, congelada na prova de cada signatário. Nula em documento comum e nas provas anteriores.

-- AlterTable
ALTER TABLE "RevalleSignatureProof" ADD COLUMN     "invoiceAccount" JSONB;
