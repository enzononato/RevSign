import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

import { normalizeCpf } from '../../../revalle/cpf';

/**
 * Chave do contador de tentativas por CPF. As chaves do `RateLimit` ficam em texto no banco, então o CPF nunca entra
 * nelas: vai o HMAC-SHA256 dele com a chave de criptografia do app (sem a chave não dá para achar o CPF de um valor
 * guardado, nem testando os CPFs possíveis).
 */
export const hashCpfForRateLimit = (cpf: string, key: string): string =>
  bytesToHex(hmac(sha256, key, `revalle-signup-cpf|v1|${normalizeCpf(cpf)}`));
