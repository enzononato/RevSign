-- REVALLE: Fase 7, perfil Contabilidade (igual ao Financeiro): quem é da Contabilidade, marcado pelo admin em Admin → Perfis.
-- Só cria a tabela; nenhuma linha existente muda.

-- CreateTable
CREATE TABLE "RevalleAccountingMember" (
    "userId" INTEGER NOT NULL,
    "addedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevalleAccountingMember_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "RevalleAccountingMember" ADD CONSTRAINT "RevalleAccountingMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
