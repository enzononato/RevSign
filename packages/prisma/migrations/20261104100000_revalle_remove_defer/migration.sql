-- REVALLE: Fase 7, sem "Deixar para o Financeiro": sai o estado AWAITING_ACCOUNT, a escolha "deixar" e a marca do e-mail
-- "aguardando o Financeiro". Linhas LEGACY ficam como estão.

-- O rascunho retido volta a ser um rascunho comum do remetente, sem escolha.
UPDATE "RevalleInvoiceClassification" SET "financeStatus" = NULL WHERE "financeStatus" = 'AWAITING_ACCOUNT';

-- A escolha "deixar" não tinha conta: quem a fez e quando também saem (a NF fica sem escolha).
UPDATE "RevalleInvoiceClassification"
SET "choiceById" = NULL, "choiceAt" = NULL, "acceptedSuggestion" = NULL
WHERE "choiceDefer" = true AND "choiceCode" IS NULL;

-- Rascunho aprovado que não é nova versão de uma troca era o envio do Financeiro ("Definir conta e enviar"): sem essa
-- ação, ninguém o destravaria. Volta a ser um rascunho do remetente, com a conta que tem.
UPDATE "RevalleInvoiceClassification" c
SET "financeStatus" = NULL, "approvedById" = NULL, "approvedAt" = NULL, "approvedAccountName" = NULL, "approvedByName" = NULL
FROM "Envelope" e
WHERE e."id" = c."envelopeId" AND e."status" = 'DRAFT' AND c."financeStatus" = 'APPROVED' AND c."previousEnvelopeId" IS NULL;

-- AlterEnum
ALTER TYPE "RevalleFinanceStatus" RENAME TO "RevalleFinanceStatus_old";
CREATE TYPE "RevalleFinanceStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'SUPERSEDED', 'LEGACY');
ALTER TABLE "RevalleInvoiceClassification" ALTER COLUMN "financeStatus" TYPE "RevalleFinanceStatus" USING "financeStatus"::text::"RevalleFinanceStatus";
DROP TYPE "RevalleFinanceStatus_old";

-- AlterTable
ALTER TABLE "RevalleInvoiceClassification" DROP COLUMN "choiceDefer",
DROP COLUMN "accountRequestedAt";
