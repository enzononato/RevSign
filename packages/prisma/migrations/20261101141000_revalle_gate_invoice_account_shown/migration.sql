-- REVALLE: Fase 6, a conta contábil que a página de assinatura mostrou a quem assina (o número). A prova só congela a
-- conta quando ela é a mesma que foi mostrada: assinatura pelo embed (sem o bloco) ou conta escolhida depois que a
-- página abriu ficam sem a linha "Conta contábil vista ao assinar".

-- AlterTable
ALTER TABLE "RevalleRecipientGate" ADD COLUMN     "invoiceAccountShownCode" TEXT;
