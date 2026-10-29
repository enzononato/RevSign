import { randomInt } from 'node:crypto';

// Sem 0, 1, I, L, O: evita caracteres que se confundem ao ditar ou digitar.
export const VERIFICATION_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export const VERIFICATION_CODE_REGEX = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;

const pick = (length: number) =>
  Array.from({ length }, () => VERIFICATION_CODE_ALPHABET[randomInt(VERIFICATION_CODE_ALPHABET.length)]).join('');

/** Código de verificação no formato XXXX-XXXX. */
export const generateVerificationCode = (): string => `${pick(4)}-${pick(4)}`;
