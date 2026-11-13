import { FieldType, RecipientRole } from '@prisma/client';

/**
 * Regras "só assinatura" (decisão de 13/11/2026):
 * 1. O único campo que se cria ou se troca num documento ou modelo é o de assinatura (`SIGNATURE`).
 *    Campos antigos de outros tipos continuam funcionando (assinar, selar, ver); só não nascem novos.
 * 2. No envio, cada destinatário que assina (`SIGNER`) precisa de ao menos uma assinatura em CADA documento do envelope.
 *
 * Arquivo puro: usado pelo servidor e pelo editor (navegador).
 */

export const REVALLE_SIGNATURE_ONLY_MESSAGE = 'Só o campo de assinatura é permitido.';

export const isRevalleAllowedFieldType = (type: FieldType | string): boolean => type === FieldType.SIGNATURE;

export type RevalleSignatureRecipient = {
  id: number;
  role: RecipientRole;
  name: string;
  email: string;
};

export type RevalleSignatureEnvelopeItem = {
  id: string;
  title: string;
};

export type RevalleSignatureField = {
  recipientId: number | null;
  envelopeItemId: string;
  type: FieldType | string;
};

export type RevalleMissingSignature<
  R extends RevalleSignatureRecipient = RevalleSignatureRecipient,
  I extends RevalleSignatureEnvelopeItem = RevalleSignatureEnvelopeItem,
> = {
  recipient: R;
  envelopeItem: I;
};

/**
 * Conta como assinatura o `SIGNATURE` e o `FREE_SIGNATURE` antigo (o mesmo critério do upstream em
 * `getRecipientsWithMissingFields`), para um rascunho antigo com assinatura livre não ficar preso.
 */
const isSignatureField = (type: FieldType | string) =>
  type === FieldType.SIGNATURE || type === FieldType.FREE_SIGNATURE;

/**
 * Pares (quem assina, documento) sem nenhuma assinatura. Só `SIGNER` precisa de campo: aprovador, visualizador, cópia
 * e assistente não. A ordem segue a dos destinatários e, dentro de cada um, a dos documentos.
 */
export const findMissingSignaturesPerItem = <
  R extends RevalleSignatureRecipient,
  I extends RevalleSignatureEnvelopeItem,
>(
  recipients: R[],
  envelopeItems: I[],
  fields: RevalleSignatureField[],
): RevalleMissingSignature<R, I>[] => {
  const signed = new Set(
    fields
      .filter((field) => field.recipientId !== null && isSignatureField(field.type))
      .map((field) => `${field.recipientId}:${field.envelopeItemId}`),
  );

  const missing: RevalleMissingSignature<R, I>[] = [];

  for (const recipient of recipients) {
    if (recipient.role !== RecipientRole.SIGNER) {
      continue;
    }

    for (const envelopeItem of envelopeItems) {
      if (!signed.has(`${recipient.id}:${envelopeItem.id}`)) {
        missing.push({ recipient, envelopeItem });
      }
    }
  }

  return missing;
};

/** Nome de quem assina para a mensagem: o nome, ou o e-mail quando não há nome. */
export const getRevalleSignerLabel = (recipient: Pick<RevalleSignatureRecipient, 'name' | 'email'>): string =>
  recipient.name.trim() || recipient.email.trim();

/** "Falta a posição da assinatura de Fulano no documento contrato.pdf." — uma frase por par, juntas por espaço. */
export const formatMissingSignaturesMessage = (missing: RevalleMissingSignature[]): string =>
  missing
    .map(
      ({ recipient, envelopeItem }) =>
        `Falta a posição da assinatura de ${getRevalleSignerLabel(recipient)} no documento ${envelopeItem.title}.`,
    )
    .join(' ');
