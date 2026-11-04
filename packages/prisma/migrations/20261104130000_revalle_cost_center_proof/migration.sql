-- REVALLE: Fase 7, o centro de custo faz parte do que é assinado: { code, name } do centro da NF visto ao assinar,
-- congelado na prova de cada signatário (nulo em NF sem centro e nas provas anteriores), e o código que a página de
-- assinatura mostrou, no portão do destinatário (a prova só congela o centro que a página mostrou).

-- AlterTable
ALTER TABLE "RevalleRecipientGate" ADD COLUMN     "invoiceCostCenterShownCode" TEXT;

-- AlterTable
ALTER TABLE "RevalleSignatureProof" ADD COLUMN     "invoiceCostCenter" JSONB;
