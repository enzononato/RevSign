-- REVALLE: Fase 7, centro de custo da nota fiscal (lista fixa no código): o código, quem escolheu e quando. NF que já
-- existe fica sem centro; depois do envio, quem a marca ou a corrige é a Contabilidade (ou o dono, na primeira vez).

-- AlterTable
ALTER TABLE "RevalleInvoiceClassification" ADD COLUMN     "costCenterAt" TIMESTAMP(3),
ADD COLUMN     "costCenterById" INTEGER,
ADD COLUMN     "costCenterCode" TEXT;
