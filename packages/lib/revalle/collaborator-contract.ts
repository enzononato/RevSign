import { formatRevalleDateTime } from './date-format';
import { normalizeEmail } from './email-domain';
import { escapeCsvCell } from './invoice/export-csv';

// REVALLE (v.21): contrato para colaboradores. Partes puras (sem banco): o tamanho do lote da varredura, o pular de
// e-mails repetidos da planilha, a linha "Assinado pela empresa" do certificado e a planilha de situação.

/** Linhas por planilha num modelo marcado como contrato para colaboradores (nos modelos comuns continua 100). */
export const REVALLE_COLLABORATOR_CONTRACT_MAX_ROWS = 3000;

/** Documentos por hora quando `NEXT_PRIVATE_REVALLE_BULK_SEND_PER_HOUR` não está definida (ou é inválida). */
export const REVALLE_BULK_SEND_DEFAULT_PER_HOUR = 100;

/** A varredura roda a cada 15 minutos: 4 vezes por hora. */
export const REVALLE_BULK_SEND_SWEEPS_PER_HOUR = 4;

/** Tentativas de envio de cada documento antes de ficar como "falhou". */
export const REVALLE_BULK_SEND_MAX_ATTEMPTS = 3;

/** Signatário genérico do modelo criado a partir do documento do representante. */
export const REVALLE_COLLABORATOR_RECIPIENT_NAME = 'Colaborador';

/**
 * Quantos documentos cada varredura envia: o ritmo por hora dividido pelas 4 varreduras, arredondado para cima (100 por
 * hora = 25 a cada 15 minutos). Valor vazio, não numérico ou menor que 1 usa o padrão.
 */
export const revalleBulkSendBatchSize = (perHourRaw: string | null | undefined): number => {
  const parsed = Number((perHourRaw ?? '').trim());
  const perHour = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : REVALLE_BULK_SEND_DEFAULT_PER_HOUR;

  return Math.ceil(perHour / REVALLE_BULK_SEND_SWEEPS_PER_HOUR);
};

export type RevalleCollaboratorRow = { name: string; email: string };

/**
 * Tira as linhas repetidas pelo mesmo e-mail (maiúsculas e espaços nas pontas não contam), mantendo a primeira. O e-mail
 * sai normalizado e o nome sem espaços nas pontas.
 */
export const dedupeCollaboratorRows = (
  rows: Array<{ name?: string | null; email?: string | null }>,
): { rows: RevalleCollaboratorRow[]; duplicates: number } => {
  const seen = new Set<string>();
  const unique: RevalleCollaboratorRow[] = [];
  let duplicates = 0;

  for (const row of rows) {
    const email = normalizeEmail(row.email ?? '');

    if (seen.has(email)) {
      duplicates += 1;
      continue;
    }

    seen.add(email);
    unique.push({ name: (row.name ?? '').trim(), email });
  }

  return { rows: unique, duplicates };
};

/** Linha do certificado (e do `/verificar`) do colaborador: quem assinou pela empresa, quando e o código dele. */
export const buildCollaboratorContractLine = ({
  representativeName,
  signedAt,
  verificationCode,
}: {
  representativeName: string;
  signedAt: Date | string;
  verificationCode: string;
}) =>
  `Assinado pela empresa: ${representativeName.trim() || 'Representante'} em ${formatRevalleDateTime(signedAt, { withZoneLabel: true })}, código ${verificationCode}`;

export type RevalleCollaboratorDocStatus = 'QUEUED' | 'FAILED' | 'SENT' | 'OPENED' | 'SIGNED' | 'REJECTED';

export const REVALLE_COLLABORATOR_STATUS_LABELS: Record<RevalleCollaboratorDocStatus, string> = {
  QUEUED: 'Na fila',
  FAILED: 'Falhou',
  SENT: 'Enviado',
  OPENED: 'Visualizado',
  SIGNED: 'Assinado',
  REJECTED: 'Recusado',
};

/** Situação de um documento do contrato: a fila manda até o envio; depois, o que o colaborador fez. */
export const collaboratorDocStatus = ({
  queueStatus,
  signingStatus,
  readStatus,
}: {
  queueStatus: 'QUEUED' | 'SENT' | 'FAILED';
  signingStatus: string | null | undefined;
  readStatus: string | null | undefined;
}): RevalleCollaboratorDocStatus => {
  if (queueStatus !== 'SENT') {
    return queueStatus;
  }

  if (signingStatus === 'SIGNED') {
    return 'SIGNED';
  }

  if (signingStatus === 'REJECTED') {
    return 'REJECTED';
  }

  return readStatus === 'OPENED' ? 'OPENED' : 'SENT';
};

const FAILURE_LABELS: Record<string, string> = {
  INVOICE_ACCOUNT_REQUIRED: 'É uma nota fiscal: o envio em massa não manda nota fiscal',
  INVOICE_EXTERNAL_RECIPIENT: 'É uma nota fiscal: o envio em massa não manda nota fiscal',
  MISSING_SIGNATURE_FIELD: 'Falta a posição da assinatura do colaborador no modelo',
  INVALID_BODY: 'E-mail recusado',
  NOT_FOUND: 'Documento não encontrado',
  TEMPLATE_DELETED: 'O modelo foi apagado',
};

/** Motivo da falha para o quadro e a planilha: só o código traduzido, nunca a mensagem (que pode ter dado pessoal). */
export const bulkSendFailureLabel = (code: string | null | undefined) => {
  if (!code) {
    return 'Erro no envio';
  }

  return FAILURE_LABELS[code] ?? `Erro no envio (${code})`;
};

export type RevalleCollaboratorStatusRow = {
  name: string;
  email: string;
  status: RevalleCollaboratorDocStatus;
  failureCode: string | null;
  date: Date | null;
};

/**
 * Planilha "situação" do contrato: nome;email;situação;data, separada por ponto e vírgula (Excel em português), com BOM
 * e a mesma neutralização de fórmulas da planilha de notas fiscais. Nunca leva CPF.
 */
export const buildCollaboratorStatusCsv = (rows: RevalleCollaboratorStatusRow[]) => {
  const lines = [
    ['nome', 'email', 'situação', 'data'].join(';'),
    ...rows.map((row) =>
      [
        row.name,
        row.email,
        row.status === 'FAILED'
          ? `${REVALLE_COLLABORATOR_STATUS_LABELS.FAILED}: ${bulkSendFailureLabel(row.failureCode)}`
          : REVALLE_COLLABORATOR_STATUS_LABELS[row.status],
        row.date ? formatRevalleDateTime(row.date) : '',
      ]
        .map(escapeCsvCell)
        .join(';'),
    ),
  ];

  return `﻿${lines.join('\r\n')}\r\n`;
};
