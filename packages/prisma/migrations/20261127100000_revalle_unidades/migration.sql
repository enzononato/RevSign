-- REVALLE (v.26): unidades (organizações marcadas), visibilidade "só o meu", escopo de unidades do Financeiro e da
-- Contabilidade e situação de usuário (histórico e "mantido ativo"). Só acrescenta; não mexe em tabela existente.

-- CreateEnum
CREATE TYPE "RevalleUserStatusAction" AS ENUM ('INACTIVATED', 'REACTIVATED', 'KEPT_ACTIVE_ON', 'KEPT_ACTIVE_OFF', 'TOTP_RESET');

-- CreateEnum
CREATE TYPE "RevalleUserStatusSource" AS ENUM ('HR_SYNC', 'ADMIN');

-- CreateTable
CREATE TABLE "RevalleUnit" (
    "organisationId" TEXT NOT NULL,
    "hrUnitName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevalleUnit_pkey" PRIMARY KEY ("organisationId")
);

-- CreateTable
CREATE TABLE "RevalleUserVisibility" (
    "userId" INTEGER NOT NULL,
    "ownOnly" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevalleUserVisibility_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "RevalleUnitScope" (
    "userId" INTEGER NOT NULL,
    "organisationId" TEXT NOT NULL,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevalleUnitScope_pkey" PRIMARY KEY ("userId","organisationId")
);

-- CreateTable
CREATE TABLE "RevalleUserStatusEvent" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "action" "RevalleUserStatusAction" NOT NULL,
    "source" "RevalleUserStatusSource" NOT NULL,
    "actorId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevalleUserStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevalleUserKeepActive" (
    "userId" INTEGER NOT NULL,
    "setById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevalleUserKeepActive_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "RevalleUnit_hrUnitName_key" ON "RevalleUnit"("hrUnitName");

-- CreateIndex
CREATE INDEX "RevalleUnitScope_organisationId_idx" ON "RevalleUnitScope"("organisationId");

-- CreateIndex
CREATE INDEX "RevalleUserStatusEvent_userId_createdAt_idx" ON "RevalleUserStatusEvent"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "RevalleUnit" ADD CONSTRAINT "RevalleUnit_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevalleUserVisibility" ADD CONSTRAINT "RevalleUserVisibility_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevalleUnitScope" ADD CONSTRAINT "RevalleUnitScope_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevalleUnitScope" ADD CONSTRAINT "RevalleUnitScope_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevalleUserKeepActive" ADD CONSTRAINT "RevalleUserKeepActive_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
