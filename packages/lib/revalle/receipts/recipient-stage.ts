import { formatRevalleDateTime } from '../date-format';

// REVALLE: em que ponto está cada destinatário: Enviado (o RevSign mandou o e-mail), Visualizado (a pessoa abriu o
// link), Assinado/Recusado. Partes puras: os eventos vêm do histórico (audit log) e os campos, do destinatário.

type RecipientRoleName = 'SIGNER' | 'APPROVER' | 'VIEWER' | 'ASSISTANT' | 'CC';

export type RecipientStage = 'NOT_SENT' | 'SENT' | 'VIEWED' | 'SIGNED' | 'REJECTED';

export type RecipientStageFields = {
  role: RecipientRoleName | string;
  sendStatus?: 'SENT' | 'NOT_SENT' | string | null;
  readStatus?: 'OPENED' | 'NOT_OPENED' | string | null;
  signingStatus: 'SIGNED' | 'NOT_SIGNED' | 'REJECTED' | string;
};

/** O estágio só com os campos que as listas já carregam (sem histórico). */
export const recipientStage = ({ sendStatus, readStatus, signingStatus }: RecipientStageFields): RecipientStage => {
  if (signingStatus === 'REJECTED') {
    return 'REJECTED';
  }

  if (signingStatus === 'SIGNED') {
    return 'SIGNED';
  }

  if (readStatus === 'OPENED') {
    return 'VIEWED';
  }

  if (sendStatus === 'SENT') {
    return 'SENT';
  }

  return 'NOT_SENT';
};

const DONE_LABELS: Record<string, string> = {
  SIGNER: 'Assinou',
  APPROVER: 'Aprovou',
  VIEWER: 'Visualização concluída',
  ASSISTANT: 'Preencheu',
};

/** O texto do estágio para o tooltip das listas ("Enviado", "Visualizado", "Assinou", "Recusou"). */
export const recipientStageLabel = (fields: RecipientStageFields) => {
  const stage = recipientStage(fields);

  switch (stage) {
    case 'REJECTED':
      return 'Recusou';
    case 'SIGNED':
      return DONE_LABELS[fields.role] ?? 'Assinou';
    case 'VIEWED':
      return 'Visualizado';
    case 'SENT':
      return 'Enviado';
    default:
      return 'Ainda não enviado';
  }
};

export type SendEventLog = {
  id?: string;
  type: string;
  createdAt: Date;
  data: unknown;
  /** E-mail de quem gerou o evento (os eventos do portão não levam `recipientId`, só o e-mail do destinatário). */
  email?: string | null;
};

export type RecipientSendEvents = {
  /** Último comprovante de envio (ou, nos documentos de antes do comprovante, o último e-mail de convite). */
  sentAt: Date | null;
  latestReceiptId: string | null;
  /** Primeira vez que a pessoa abriu o link. */
  openedAt: Date | null;
  rejectedAt: Date | null;
  /** v.26: a última confirmação do código foi pelo app autenticador da conta (só presente quando verdadeiro). */
  signedByAuthenticator?: boolean;
};

/** v.26: texto do passo Assinado quando a confirmação foi pelo app autenticador. */
export const AUTHENTICATOR_STEP_DETAIL = 'Assinatura confirmada pelo app autenticador';

// E-mails que levam o link de assinatura (os de antes do comprovante contam como "Enviado").
const INVITE_EMAIL_TYPES = new Set([
  'SIGNING_REQUEST',
  'VIEW_REQUEST',
  'APPROVE_REQUEST',
  'ASSISTING_REQUEST',
  'REMINDER',
]);

// Prova de que a pessoa abriu o link: a abertura do documento e os passos do portão (termo, identidade, código), que só
// quem está com o link na mão faz. O desbloqueio é do admin: não conta.
export const OPEN_EVIDENCE_TYPES = [
  'DOCUMENT_OPENED',
  'DOCUMENT_VIEWED',
  'DOCUMENT_ACCESS_AUTH_2FA_REQUESTED',
  'REVALLE_TERM_ACCEPTED',
  'REVALLE_IDENTITY_FAILED',
  'REVALLE_IDENTITY_CONFIRMED',
  'REVALLE_IDENTITY_LINKED',
  'REVALLE_IDENTITY_SKIPPED',
  'REVALLE_GATE_LOCKED',
] as const;

const OPEN_EVIDENCE = new Set<string>(OPEN_EVIDENCE_TYPES);

const readRecipientId = (data: unknown): number | null => {
  if (data && typeof data === 'object' && 'recipientId' in data) {
    const value = (data as { recipientId: unknown }).recipientId;

    return typeof value === 'number' ? value : null;
  }

  return null;
};

const readString = (data: unknown, key: string): string | null => {
  if (data && typeof data === 'object' && key in data) {
    const value = (data as Record<string, unknown>)[key];

    return typeof value === 'string' ? value : null;
  }

  return null;
};

const empty = (): RecipientSendEvents => ({ sentAt: null, latestReceiptId: null, openedAt: null, rejectedAt: null });

const normalize = (email: string) => email.trim().toLowerCase();

/**
 * Junta, por destinatário, o último envio, a primeira abertura e a recusa. A ordem dos eventos não importa.
 * `recipients` (id e e-mail) liga os eventos do portão, que só têm o e-mail, ao destinatário (só e-mail sem repetição).
 */
export const collectRecipientSendEvents = (
  logs: SendEventLog[],
  recipients: { id: number; email: string }[] = [],
): Map<number, RecipientSendEvents> => {
  const byRecipient = new Map<number, RecipientSendEvents>();
  const legacySent = new Map<number, Date>();
  // v.26: a última confirmação do código por destinatário (vale o método da mais nova, como na prova).
  const lastCode = new Map<number, { at: Date; byAuthenticator: boolean }>();

  const idByEmail = new Map<string, number | null>();

  for (const recipient of recipients) {
    const key = normalize(recipient.email);

    idByEmail.set(key, idByEmail.has(key) ? null : recipient.id);
  }

  const get = (recipientId: number) => {
    let events = byRecipient.get(recipientId);

    if (!events) {
      events = empty();
      byRecipient.set(recipientId, events);
    }

    return events;
  };

  for (const log of logs) {
    const recipientId =
      readRecipientId(log.data) ??
      (OPEN_EVIDENCE.has(log.type) && log.email ? (idByEmail.get(normalize(log.email)) ?? null) : null);

    if (recipientId === null) {
      continue;
    }

    if (log.type === 'REVALLE_SEND_RECEIPT') {
      const events = get(recipientId);

      if (!events.sentAt || log.createdAt.getTime() >= events.sentAt.getTime()) {
        events.sentAt = log.createdAt;
        events.latestReceiptId = readString(log.data, 'receiptId');
      }
    } else if (log.type === 'EMAIL_SENT') {
      const emailType = readString(log.data, 'emailType');

      if (emailType && INVITE_EMAIL_TYPES.has(emailType)) {
        const previous = legacySent.get(recipientId);

        if (!previous || log.createdAt.getTime() > previous.getTime()) {
          legacySent.set(recipientId, log.createdAt);
        }
      }
    } else if (OPEN_EVIDENCE.has(log.type)) {
      const events = get(recipientId);

      if (!events.openedAt || log.createdAt.getTime() < events.openedAt.getTime()) {
        events.openedAt = log.createdAt;
      }
    } else if (log.type === 'DOCUMENT_ACCESS_AUTH_2FA_VALIDATED') {
      const previous = lastCode.get(recipientId);

      if (!previous || log.createdAt.getTime() >= previous.at.getTime()) {
        lastCode.set(recipientId, {
          at: log.createdAt,
          byAuthenticator: readString(log.data, 'revalleMethod') === 'AUTHENTICATOR',
        });
      }
    } else if (log.type === 'DOCUMENT_RECIPIENT_REJECTED') {
      const events = get(recipientId);

      if (!events.rejectedAt || log.createdAt.getTime() > events.rejectedAt.getTime()) {
        events.rejectedAt = log.createdAt;
      }
    }
  }

  for (const [recipientId, code] of lastCode) {
    if (code.byAuthenticator) {
      get(recipientId).signedByAuthenticator = true;
    }
  }

  // Documento enviado antes do comprovante: o último convite por e-mail vale como "Enviado".
  for (const [recipientId, sentAt] of legacySent) {
    const events = get(recipientId);

    if (!events.sentAt) {
      events.sentAt = sentAt;
    }
  }

  return byRecipient;
};

export type TimelineStepKey = 'SENT' | 'VIEWED' | 'SIGNED' | 'REJECTED';

export type TimelineStep = {
  key: TimelineStepKey;
  label: string;
  reached: boolean;
  at: Date | null;
  /** v.26: complemento do passo (ex.: "Assinatura confirmada pelo app autenticador"); ausente quando não há. */
  detail?: string;
};

const DONE_STEP_LABELS: Record<string, string> = {
  SIGNER: 'Assinado',
  APPROVER: 'Aprovado',
  VIEWER: 'Concluído',
  ASSISTANT: 'Preenchido',
};

/**
 * Os 3 passos de um destinatário: Enviado, Visualizado e Assinado (ou Recusado). Passo não alcançado vem com
 * `reached: false`. Quem só recebe cópia (CC) não recebe link de assinatura: sem passos.
 */
export const buildRecipientTimeline = (
  recipient: RecipientStageFields & { signedAt?: Date | null },
  events: RecipientSendEvents | undefined,
): TimelineStep[] => {
  if (recipient.role === 'CC') {
    return [];
  }

  const { sentAt, openedAt, rejectedAt, signedByAuthenticator } = events ?? empty();
  const isRejected = recipient.signingStatus === 'REJECTED';
  const isDone = recipient.signingStatus === 'SIGNED';
  // Abriu antes do histórico guardar a abertura: o passo vale, sem horário.
  const wasOpened = Boolean(openedAt) || recipient.readStatus === 'OPENED';

  const steps: TimelineStep[] = [
    { key: 'SENT', label: 'Enviado', reached: Boolean(sentAt), at: sentAt },
    { key: 'VIEWED', label: 'Visualizado', reached: wasOpened, at: openedAt },
  ];

  if (isRejected) {
    steps.push({ key: 'REJECTED', label: 'Recusado', reached: true, at: rejectedAt ?? recipient.signedAt ?? null });
  } else {
    steps.push({
      key: 'SIGNED',
      label: DONE_STEP_LABELS[recipient.role] ?? 'Assinado',
      reached: isDone,
      at: isDone ? (recipient.signedAt ?? null) : null,
      ...(isDone && signedByAuthenticator ? { detail: AUTHENTICATOR_STEP_DETAIL } : {}),
    });
  }

  return steps;
};

export type SerializedTimelineStep = Omit<TimelineStep, 'at'> & {
  /** dd/MM/yyyy HH:mm no horário de Brasília; nulo = sem horário (ou não alcançado). */
  atLabel: string | null;
};

/** Para mandar ao navegador já no horário de Brasília (o fuso do navegador não muda o que aparece). */
export const serializeTimeline = (steps: TimelineStep[]): SerializedTimelineStep[] =>
  steps.map(({ at, ...step }) => ({ ...step, atLabel: at ? formatRevalleDateTime(at) : null }));

export const SEND_STATUS_EXPLANATION =
  'Enviado = o RevSign enviou o e-mail. Visualizado = a pessoa abriu o link do documento.';
