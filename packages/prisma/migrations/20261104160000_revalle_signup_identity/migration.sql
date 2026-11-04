-- REVALLE: Fase 7, cadastro com CPF e data de nascimento. O CPF informado no cadastro fica aqui até o e-mail ser
-- confirmado; só então vira RevalleEmailLink. Sem índice único no CPF: dois cadastros não confirmados podem trazer o
-- mesmo CPF. Só cria a tabela; nenhuma linha existente muda.

-- CreateTable
CREATE TABLE "RevalleSignupIdentity" (
    "userId" INTEGER NOT NULL,
    "cpf" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevalleSignupIdentity_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "RevalleSignupIdentity" ADD CONSTRAINT "RevalleSignupIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
