// REVALLE: integração com o Patrimônio. Casca HTTP comum das rotas `/api/revalle/patrimonio/v1/…`: integração
// desligada (404), limite por IP, chave, conta remetente, erros em `{ error: { code, message } }`. Log só com códigos e
// ids, nunca CPF, e-mail ou conteúdo do termo.

import { PatrimonioError } from '../../../revalle/patrimonio/request';
import type { ApiRequestMetadata } from '../../../universal/extract-request-metadata';
import { extractRequestMetadata } from '../../../universal/extract-request-metadata';
import { getIpAddress } from '../../../universal/get-ip-address';
import { logger } from '../../../utils/logger';
import { createRateLimit } from '../../rate-limit/rate-limit';
import { revalleErrorCode } from '../error-code';
import { revalleRateLimitIpKey } from '../rate-limit-ip-key';
import { getPatrimonioApiKey, getPatrimonioSender, isPatrimonioAuthorized, type PatrimonioSender } from './config';

/** Todo pedido conta, autorizado ou não. */
const requestRateLimit = createRateLimit({ action: 'revalle.patrimonio', max: 120, window: '1m' });

/** Chave errada ou ausente: poucas tentativas por IP. */
const authFailureRateLimit = createRateLimit({ action: 'revalle.patrimonio-auth', max: 20, window: '15m' });

const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export const patrimonioJson = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });

export const patrimonioErrorResponse = (error: PatrimonioError) =>
  patrimonioJson(
    { error: { code: error.code, message: error.message, ...(error.extra ?? {}) } },
    error.status,
    error.headers ?? {},
  );

const retryAfter = (reset: Date) => ({
  'Retry-After': String(Math.max(1, Math.ceil((reset.getTime() - Date.now()) / 1000))),
});

export type PatrimonioRequestContext = {
  sender: PatrimonioSender;
  requestMetadata: ApiRequestMetadata;
};

/**
 * Roda `handler` depois das conferências comuns. Erros `PatrimonioError` viram a resposta JSON do código; qualquer
 * outro erro vira `INTERNAL_ERROR` (500), registrado só com o código.
 */
export const handlePatrimonioRequest = async (
  request: Request,
  route: string,
  handler: (context: PatrimonioRequestContext) => Promise<Response>,
): Promise<Response> => {
  const key = getPatrimonioApiKey();

  if (!key) {
    return patrimonioErrorResponse(new PatrimonioError('NOT_CONFIGURED', 'Integração desligada.'));
  }

  let ip = 'unknown';

  try {
    ip = revalleRateLimitIpKey(getIpAddress(request));
  } catch {
    // Sem IP (chamada pela rede interna, sem proxy): todos no mesmo balde.
  }

  try {
    const limit = await requestRateLimit.check({ ip });

    if (limit.isLimited) {
      return patrimonioErrorResponse(
        new PatrimonioError('RATE_LIMITED', 'Muitos pedidos. Tente de novo em instantes.', {
          headers: retryAfter(limit.reset),
        }),
      );
    }

    if (!isPatrimonioAuthorized(request.headers.get('authorization'), key)) {
      const failures = await authFailureRateLimit.check({ ip });

      if (failures.isLimited) {
        return patrimonioErrorResponse(
          new PatrimonioError('RATE_LIMITED', 'Muitas tentativas sem chave válida.', {
            headers: retryAfter(failures.reset),
          }),
        );
      }

      return patrimonioErrorResponse(new PatrimonioError('UNAUTHORIZED', 'Chave ausente ou inválida.'));
    }

    const sender = await getPatrimonioSender();

    if (!sender) {
      return patrimonioErrorResponse(new PatrimonioError('NOT_CONFIGURED', 'Integração sem conta remetente.'));
    }

    const requestMetadata: ApiRequestMetadata = {
      requestMetadata: extractRequestMetadata(request),
      source: 'apiV2',
      auth: 'api',
      auditUser: { id: sender.userId, email: sender.email, name: sender.name },
    };

    return await handler({ sender, requestMetadata });
  } catch (error) {
    if (error instanceof PatrimonioError) {
      return patrimonioErrorResponse(error);
    }

    logger.error({ msg: '[RevSign] Patrimônio: erro na rota', route, code: revalleErrorCode(error) });

    return patrimonioErrorResponse(new PatrimonioError('INTERNAL_ERROR', 'Erro interno. Tente de novo.'));
  }
};

export const patrimonioMethodNotAllowed = async (request: Request, route: string) =>
  await handlePatrimonioRequest(request, route, async () => {
    throw new PatrimonioError('METHOD_NOT_ALLOWED', 'Método não aceito nesta rota.');
  });
