import { createHash } from 'node:crypto';

/** SHA-256 em hexadecimal minúsculo (64 caracteres) dos bytes recebidos. */
export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
