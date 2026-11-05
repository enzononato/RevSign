-- REVALLE: Fase 8, o alerta de nota duplicada. `accessKeys` guarda as chaves de acesso válidas da NF (do texto dos arquivos
-- e, na NF escaneada, a que a IA leu). Só acrescenta uma coluna com valor padrão constante (o Postgres 11+ não reescreve a
-- tabela) e dois índices: um GIN nas chaves (a busca "alguma chave em comum") e um no hash do arquivo (a busca "mesmo
-- arquivo"). Sem preenchimento das linhas existentes: a NF antiga continua sendo achada pelo mesmo arquivo.

-- AlterTable
ALTER TABLE "RevalleInvoiceClassification" ADD COLUMN     "accessKeys" TEXT[] NOT NULL DEFAULT '{}';

-- CreateIndex
CREATE INDEX "RevalleInvoiceClassification_accessKeys_idx" ON "RevalleInvoiceClassification" USING GIN ("accessKeys");

-- CreateIndex
CREATE INDEX "RevalleInvoiceClassification_fileSha256_idx" ON "RevalleInvoiceClassification"("fileSha256");
