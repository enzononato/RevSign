import { maskCpf } from './cpf';
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
  /** v.22: o CPF da lista; sai sempre mascarado. */
  cpf?: string | null;
  status: RevalleCollaboratorDocStatus;
  failureCode: string | null;
  date: Date | null;
};

/**
 * Planilha "situação" do contrato: nome;email;situação;data, separada por ponto e vírgula (Excel em português), com BOM
 * e a mesma neutralização de fórmulas da planilha de notas fiscais. Com `withMaskedCpf` (página própria, v.22), a
 * coluna CPF vem depois do e-mail, sempre mascarada; sem ela, nenhum CPF (v.21).
 */
export const buildCollaboratorStatusCsv = (
  rows: RevalleCollaboratorStatusRow[],
  { withMaskedCpf = false }: { withMaskedCpf?: boolean } = {},
) => {
  const lines = [
    (withMaskedCpf ? ['nome', 'email', 'CPF', 'situação', 'data'] : ['nome', 'email', 'situação', 'data']).join(';'),
    ...rows.map((row) =>
      [
        row.name,
        row.email,
        ...(withMaskedCpf ? [row.cpf ? maskCpf(row.cpf) : ''] : []),
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

// REVALLE (v.22): contrato para colaboradores pela página própria.

/** "Nome do remetente" quando o admin não muda: o nome no assunto do convite. */
export const REVALLE_COLLABORATOR_DEFAULT_SENDER_NAME = 'Revalle';

/** "Reenviar" de uma pessoa: no máximo 1 vez a cada 10 minutos. */
export const REVALLE_COLLABORATOR_RESEND_INTERVAL_MS = 10 * 60 * 1000;

export type RevalleCollaboratorContractStatus =
  | 'DRAFT'
  | 'AWAITING_REPRESENTATIVE'
  | 'SENDING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'REJECTED_BY_REPRESENTATIVE';

export const REVALLE_COLLABORATOR_CONTRACT_STATUS_LABELS: Record<RevalleCollaboratorContractStatus, string> = {
  DRAFT: 'Montando',
  AWAITING_REPRESENTATIVE: 'Aguardando representante',
  SENDING: 'Enviando',
  PAUSED: 'Pausado',
  COMPLETED: 'Concluído',
  REJECTED_BY_REPRESENTATIVE: 'Recusado pelo representante',
};

/**
 * A situação mostrada do contrato. O banco guarda até "Enviando"/"Pausado"; "Concluído" é quando os documentos já foram
 * todos criados e cada colaborador assinou, recusou ou falhou.
 */
export const effectiveCollaboratorContractStatus = ({
  status,
  paused,
  total,
  finished,
  isBuilding,
}: {
  status: RevalleCollaboratorContractStatus;
  paused: boolean;
  total: number;
  finished: number;
  isBuilding: boolean;
}): RevalleCollaboratorContractStatus => {
  if (status === 'DRAFT' || status === 'AWAITING_REPRESENTATIVE' || status === 'REJECTED_BY_REPRESENTATIVE') {
    return status;
  }

  if (total > 0 && finished >= total && !isBuilding) {
    return 'COMPLETED';
  }

  return paused ? 'PAUSED' : 'SENDING';
};
