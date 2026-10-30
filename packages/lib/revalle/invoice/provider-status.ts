import { APICallError, RetryError } from 'ai';

/**
 * Código HTTP da resposta do provedor (429 cota, 403 chave, 404 modelo retirado), para o log da sugestão. Só o número:
 * o erro em si pode trazer o pedido (o texto da NF) e o corpo da resposta, que nunca vão para o log.
 */
export const providerStatusCode = (error: unknown): number | undefined => {
  const source = RetryError.isInstance(error) ? error.lastError : error;

  return APICallError.isInstance(source) && typeof source.statusCode === 'number' ? source.statusCode : undefined;
};
