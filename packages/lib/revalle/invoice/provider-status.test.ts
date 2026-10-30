import { APICallError, RetryError } from 'ai';
import { describe, expect, it } from 'vitest';

import { providerStatusCode } from './provider-status';

const apiError = (statusCode?: number) =>
  new APICallError({
    message: 'falhou',
    url: 'https://generativelanguage.googleapis.com/v1beta/models/x:generateContent',
    requestBodyValues: { contents: 'texto da NF que nunca pode ir para o log' },
    statusCode,
    responseBody: '{"error":"corpo do provedor"}',
  });

describe('providerStatusCode', () => {
  it('lê o statusCode de um APICallError', () => {
    expect(providerStatusCode(apiError(429))).toBe(429);
    expect(providerStatusCode(apiError(403))).toBe(403);
  });

  it('lê o statusCode do último erro de um RetryError', () => {
    const error = new RetryError({
      message: 'tentativas esgotadas',
      reason: 'maxRetriesExceeded',
      errors: [apiError(503), apiError(404)],
    });

    expect(providerStatusCode(error)).toBe(404);
  });

  it('sem statusCode ou outro erro: undefined (nunca o corpo nem a mensagem)', () => {
    expect(providerStatusCode(apiError(undefined))).toBeUndefined();
    expect(providerStatusCode(new Error('rede caiu'))).toBeUndefined();
    expect(providerStatusCode('texto')).toBeUndefined();
    expect(
      providerStatusCode(new RetryError({ message: 'x', reason: 'abort', errors: [new Error('abortado')] })),
    ).toBeUndefined();
  });
});
