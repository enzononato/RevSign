// REVALLE: integração com o Patrimônio. Validação pura do pedido de criação de termo (campos do multipart e arquivo).
// Nada aqui consulta banco ou rede: as rotas leem o multipart e passam os campos e os bytes para cá.

import { z } from 'zod';

import { isValidCpf, normalizeCpf } from '../cpf';

export const PATRIMONIO_MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Corpo inteiro do multipart: o arquivo de até 10 MB mais os campos e as fronteiras. */
export const PATRIMONIO_MAX_BODY_BYTES = PATRIMONIO_MAX_FILE_BYTES + 256 * 1024;

export const PATRIMONIO_TERMO_KINDS = ['ENTREGA', 'DEVOLUCAO'] as const;

export type PatrimonioTermoKind = (typeof PATRIMONIO_TERMO_KINDS)[number];

export const PATRIMONIO_ERROR_STATUS = {
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  INVALID_REQUEST: 400,
  INVALID_FILE: 422,
  FILE_TOO_LARGE: 413,
  MARKER_NOT_FOUND: 422,
  INVALID_CPF: 422,
  COLABORADOR_NOT_FOUND: 422,
  HR_BASE_UNAVAILABLE: 503,
  DUPLICATE_EXTERNAL_ID: 409,
  NOT_PENDING: 409,
  NOT_SIGNED: 409,
  RESEND_TOO_SOON: 429,
  RATE_LIMITED: 429,
  NOT_CONFIGURED: 404,
  METHOD_NOT_ALLOWED: 405,
  INTERNAL_ERROR: 500,
} as const;

export type PatrimonioErrorCode = keyof typeof PATRIMONIO_ERROR_STATUS;

export class PatrimonioError extends Error {
  readonly code: PatrimonioErrorCode;
  readonly status: number;
  readonly extra: Record<string, unknown> | undefined;
  readonly headers: Record<string, string> | undefined;

  constructor(
    code: PatrimonioErrorCode,
    message: string,
    options: { extra?: Record<string, unknown>; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = 'PatrimonioError';
    this.code = code;
    this.status = PATRIMONIO_ERROR_STATUS[code];
    this.extra = options.extra;
    this.headers = options.headers;
  }
}

export const PATRIMONIO_EXTERNAL_ID_REGEX = /^[A-Za-z0-9._:-]{1,120}$/;

const trimmed = (max: number) => z.string().trim().min(1).max(max);

const ZCreateTermoFieldsSchema = z.object({
  externalId: z.string().regex(PATRIMONIO_EXTERNAL_ID_REGEX),
  kind: z.enum(PATRIMONIO_TERMO_KINDS),
  title: trimmed(200),
  signerName: trimmed(255),
  signerEmail: z.string().trim().toLowerCase().max(254).email(),
  signerCpf: z.string().trim().min(1).max(20),
  message: z.string().trim().max(2000).optional(),
});

export type PatrimonioCreateTermoFields = Omit<z.infer<typeof ZCreateTermoFieldsSchema>, 'message'> & {
  message: string | undefined;
};

const FIELD_NAMES = ['externalId', 'kind', 'title', 'signerName', 'signerEmail', 'signerCpf', 'message'] as const;

const FIELD_HINTS: Record<(typeof FIELD_NAMES)[number], string> = {
  externalId: 'até 120 caracteres: letras, números, ponto, sublinhado, dois-pontos e hífen',
  kind: 'ENTREGA ou DEVOLUCAO',
  title: 'obrigatório, até 200 caracteres',
  signerName: 'obrigatório, até 255 caracteres',
  signerEmail: 'e-mail válido',
  signerCpf: 'obrigatório',
  message: 'até 2000 caracteres',
};

/**
 * Confere os campos de texto do multipart. `fields` traz o valor de cada campo como veio (string), ou `undefined` se
 * faltou. Lança `PatrimonioError` (INVALID_REQUEST ou INVALID_CPF); devolve o CPF só com os 11 números.
 */
export const parseCreateTermoFields = (fields: Record<string, unknown>): PatrimonioCreateTermoFields => {
  for (const name of FIELD_NAMES) {
    const value = fields[name];

    if (value !== undefined && typeof value !== 'string') {
      throw new PatrimonioError('INVALID_REQUEST', `Campo ${name} inválido: envie texto.`);
    }
  }

  const message = typeof fields.message === 'string' && fields.message.trim() !== '' ? fields.message : undefined;
  const parsed = ZCreateTermoFieldsSchema.safeParse({ ...fields, message });

  if (!parsed.success) {
    const name = parsed.error.issues[0]?.path[0];
    const field = FIELD_NAMES.find((candidate) => candidate === name);

    throw new PatrimonioError(
      'INVALID_REQUEST',
      field ? `Campo ${field} inválido (${FIELD_HINTS[field]}).` : 'Campos inválidos.',
    );
  }

  if (!isValidCpf(parsed.data.signerCpf)) {
    throw new PatrimonioError('INVALID_CPF', 'CPF inválido.');
  }

  return { ...parsed.data, signerCpf: normalizeCpf(parsed.data.signerCpf), message: parsed.data.message };
};

/** O arquivo começa com `%PDF-` (como o LibreOffice gera). */
export const hasPdfMagicBytes = (bytes: Uint8Array): boolean =>
  bytes.length >= 5 &&
  bytes[0] === 0x25 &&
  bytes[1] === 0x50 &&
  bytes[2] === 0x44 &&
  bytes[3] === 0x46 &&
  bytes[4] === 0x2d;

/** Tamanho e assinatura do arquivo. Lança `PatrimonioError` (FILE_TOO_LARGE ou INVALID_FILE). */
export const assertTermoFile = (bytes: Uint8Array): void => {
  if (bytes.length > PATRIMONIO_MAX_FILE_BYTES) {
    throw new PatrimonioError('FILE_TOO_LARGE', 'O arquivo passa de 10 MB.');
  }

  if (!hasPdfMagicBytes(bytes)) {
    throw new PatrimonioError('INVALID_FILE', 'O arquivo não é um PDF.');
  }
};

/** Motivo do cancelamento (opcional): texto de até 500 caracteres. */
export const parseCancelReason = (body: unknown): string | undefined => {
  if (body === undefined || body === null) {
    return undefined;
  }

  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new PatrimonioError('INVALID_REQUEST', 'Corpo inválido: envie um objeto JSON.');
  }

  const { reason } = body as { reason?: unknown };

  if (reason === undefined || reason === null) {
    return undefined;
  }

  if (typeof reason !== 'string' || reason.trim().length > 500) {
    throw new PatrimonioError('INVALID_REQUEST', 'Campo reason inválido (texto de até 500 caracteres).');
  }

  return reason.trim() === '' ? undefined : reason.trim();
};
