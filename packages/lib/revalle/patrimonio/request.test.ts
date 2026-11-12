import { describe, expect, it } from 'vitest';

import {
  assertTermoFile,
  hasPdfMagicBytes,
  PATRIMONIO_MAX_FILE_BYTES,
  PatrimonioError,
  parseCancelReason,
  parseCreateTermoFields,
} from './request';

const VALID = {
  externalId: 'PAT-2026:000123_a.b',
  kind: 'ENTREGA',
  title: 'Termo de entrega - Notebook',
  signerName: 'Fulano de Tal',
  signerEmail: 'Fulano@Gmail.com',
  signerCpf: '390.533.447-05',
};

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof PatrimonioError ? error.code : 'OTHER';
  }

  return null;
};

describe('parseCreateTermoFields', () => {
  it('aceita o pedido válido e normaliza CPF e e-mail', () => {
    const parsed = parseCreateTermoFields({ ...VALID, message: '  Olá  ' });

    expect(parsed.signerCpf).toBe('39053344705');
    expect(parsed.signerEmail).toBe('fulano@gmail.com');
    expect(parsed.message).toBe('Olá');
    expect(parsed.kind).toBe('ENTREGA');
  });

  it('mensagem vazia vira undefined', () => {
    expect(parseCreateTermoFields({ ...VALID, message: '   ' }).message).toBeUndefined();
  });

  it.each([
    ['externalId ausente', { externalId: undefined }],
    ['externalId com espaço', { externalId: 'PAT 1' }],
    ['externalId com barra', { externalId: 'PAT/1' }],
    ['externalId longo', { externalId: 'a'.repeat(121) }],
    ['kind desconhecido', { kind: 'EMPRESTIMO' }],
    ['kind em minúsculas', { kind: 'entrega' }],
    ['título vazio', { title: '  ' }],
    ['título longo', { title: 'x'.repeat(201) }],
    ['nome ausente', { signerName: undefined }],
    ['e-mail inválido', { signerEmail: 'fulano@' }],
    ['CPF ausente', { signerCpf: undefined }],
    ['mensagem longa', { message: 'm'.repeat(2001) }],
  ])('%s → INVALID_REQUEST', (_name, override) => {
    expect(codeOf(() => parseCreateTermoFields({ ...VALID, ...override }))).toBe('INVALID_REQUEST');
  });

  it('campo que não é texto (arquivo no lugar) → INVALID_REQUEST', () => {
    expect(codeOf(() => parseCreateTermoFields({ ...VALID, title: new Blob(['x']) }))).toBe('INVALID_REQUEST');
  });

  it.each(['390.533.447-06', '11111111111', '123'])('CPF %s → INVALID_CPF', (cpf) => {
    expect(codeOf(() => parseCreateTermoFields({ ...VALID, signerCpf: cpf }))).toBe('INVALID_CPF');
  });

  it('aceita o externalId no limite de 120 caracteres e DEVOLUCAO', () => {
    expect(parseCreateTermoFields({ ...VALID, externalId: 'a'.repeat(120), kind: 'DEVOLUCAO' }).kind).toBe('DEVOLUCAO');
  });
});

describe('arquivo', () => {
  const pdf = (size: number) => {
    const bytes = new Uint8Array(size);

    bytes.set(new TextEncoder().encode('%PDF-1.7'));

    return bytes;
  };

  it('reconhece a assinatura %PDF-', () => {
    expect(hasPdfMagicBytes(new TextEncoder().encode('%PDF-1.4\n'))).toBe(true);
    expect(hasPdfMagicBytes(new TextEncoder().encode('PK\u0003\u0004'))).toBe(false);
    expect(hasPdfMagicBytes(new TextEncoder().encode(' %PDF-1.4'))).toBe(false);
    expect(hasPdfMagicBytes(new Uint8Array(0))).toBe(false);
  });

  it('aceita até 10 MB e recusa acima', () => {
    expect(codeOf(() => assertTermoFile(pdf(PATRIMONIO_MAX_FILE_BYTES)))).toBeNull();
    expect(codeOf(() => assertTermoFile(pdf(PATRIMONIO_MAX_FILE_BYTES + 1)))).toBe('FILE_TOO_LARGE');
  });

  it('.docx (zip) ou vazio → INVALID_FILE', () => {
    expect(codeOf(() => assertTermoFile(new TextEncoder().encode('PK\u0003\u0004rest')))).toBe('INVALID_FILE');
    expect(codeOf(() => assertTermoFile(new Uint8Array(0)))).toBe('INVALID_FILE');
  });
});

describe('parseCancelReason', () => {
  it('corpo vazio ou sem reason → undefined', () => {
    expect(parseCancelReason(undefined)).toBeUndefined();
    expect(parseCancelReason({})).toBeUndefined();
    expect(parseCancelReason({ reason: '   ' })).toBeUndefined();
  });

  it('devolve o motivo sem espaços nas pontas', () => {
    expect(parseCancelReason({ reason: ' troca de equipamento ' })).toBe('troca de equipamento');
  });

  it('motivo inválido → INVALID_REQUEST', () => {
    expect(codeOf(() => parseCancelReason({ reason: 1 }))).toBe('INVALID_REQUEST');
    expect(codeOf(() => parseCancelReason({ reason: 'x'.repeat(501) }))).toBe('INVALID_REQUEST');
    expect(codeOf(() => parseCancelReason(['x']))).toBe('INVALID_REQUEST');
  });
});

describe('PatrimonioError', () => {
  it('leva o status HTTP do código', () => {
    expect(new PatrimonioError('DUPLICATE_EXTERNAL_ID', 'x').status).toBe(409);
    expect(new PatrimonioError('NOT_CONFIGURED', 'x').status).toBe(404);
    expect(new PatrimonioError('FILE_TOO_LARGE', 'x').status).toBe(413);
    expect(new PatrimonioError('RESEND_TOO_SOON', 'x').status).toBe(429);
  });
});
