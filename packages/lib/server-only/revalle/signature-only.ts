import type { FieldType } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';
import {
  findMissingSignaturesPerItem,
  formatMissingSignaturesMessage,
  isRevalleAllowedFieldType,
  REVALLE_SIGNATURE_ONLY_MESSAGE,
  type RevalleSignatureEnvelopeItem,
  type RevalleSignatureField,
  type RevalleSignatureRecipient,
} from '../../revalle/signature-only';

/**
 * Recusa (400) a criação ou a troca de campo para qualquer tipo que não seja assinatura.
 * Quem chama passa só os tipos NOVOS: campo antigo que mantém o tipo continua valendo.
 */
export const assertRevalleFieldTypesAllowed = (types: Array<FieldType | string>) => {
  if (types.some((type) => !isRevalleAllowedFieldType(type))) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: REVALLE_SIGNATURE_ONLY_MESSAGE,
      userMessage: REVALLE_SIGNATURE_ONLY_MESSAGE,
    });
  }
};

/**
 * Recusa (400, `MISSING_SIGNATURE_FIELD`) o envio quando algum `SIGNER` não tem assinatura em algum documento do
 * envelope. A mensagem nomeia cada par (quem, documento).
 */
export const assertSignaturesInEveryItem = (
  recipients: RevalleSignatureRecipient[],
  envelopeItems: RevalleSignatureEnvelopeItem[],
  fields: RevalleSignatureField[],
) => {
  const missing = findMissingSignaturesPerItem(recipients, envelopeItems, fields);

  if (missing.length > 0) {
    const message = formatMissingSignaturesMessage(missing);

    throw new AppError(AppErrorCode.MISSING_SIGNATURE_FIELD, { message, userMessage: message });
  }
};
