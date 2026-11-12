-- REVALLE: integração com o Patrimônio (termos de responsabilidade de equipamento). Só cria duas tabelas novas; nenhuma
-- linha existente muda. `RevallePatrimonioTermo` marca o envelope como termo (FK com cascade); `RevallePatrimonioEvent`
-- guarda os avisos ao Patrimônio e as tentativas de entrega (sem FK, sem CPF).

-- CreateTable
CREATE TABLE "RevallePatrimonioTermo" (
    "envelopeId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "activeExternalId" TEXT,
    "kind" TEXT NOT NULL,
    "signerCpf" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "lastResendAt" TIMESTAMP(3),

    CONSTRAINT "RevallePatrimonioTermo_pkey" PRIMARY KEY ("envelopeId")
);

-- CreateTable
CREATE TABLE "RevallePatrimonioEvent" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "RevallePatrimonioEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RevallePatrimonioTermo_activeExternalId_key" ON "RevallePatrimonioTermo"("activeExternalId");

-- CreateIndex
CREATE INDEX "RevallePatrimonioTermo_externalId_idx" ON "RevallePatrimonioTermo"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "RevallePatrimonioEvent_envelopeId_event_key" ON "RevallePatrimonioEvent"("envelopeId", "event");

-- CreateIndex
CREATE INDEX "RevallePatrimonioEvent_deliveredAt_nextAttemptAt_idx" ON "RevallePatrimonioEvent"("deliveredAt", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "RevallePatrimonioTermo" ADD CONSTRAINT "RevallePatrimonioTermo_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "Envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;
