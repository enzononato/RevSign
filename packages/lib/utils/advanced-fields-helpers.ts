import { type Field, FieldType, RecipientRole } from '@prisma/client'; // REVALLE: RecipientRole

import { ZFieldMetaSchema } from '../types/field-meta';

// Currently it seems that the majority of fields have advanced fields for font reasons.
// This array should only contain fields that have an optional setting in the fieldMeta.
export const ADVANCED_FIELD_TYPES_WITH_OPTIONAL_SETTING: FieldType[] = [
  FieldType.NUMBER,
  FieldType.TEXT,
  FieldType.DROPDOWN,
  FieldType.RADIO,
  FieldType.CHECKBOX,
];

/**
 * Whether a field is required to be inserted.
 */
export const isRequiredField = (field: Field, recipientRole?: RecipientRole) => {
  // REVALLE: para o SIGNER, desenhar é opcional (o servidor insere o carimbo ao concluir). Sem papel informado,
  // ou para APPROVER/ASSISTANT, a assinatura continua obrigatória como no upstream.
  if (field.type === FieldType.SIGNATURE && recipientRole === RecipientRole.SIGNER) {
    return false;
  }

  // All fields without the optional metadata are assumed to be required.
  if (!ADVANCED_FIELD_TYPES_WITH_OPTIONAL_SETTING.includes(field.type)) {
    return true;
  }

  // Not sure why fieldMeta can be optional for advanced fields, but it is.
  // Therefore we must assume if there is no fieldMeta, then the field is optional.
  if (!field.fieldMeta) {
    return false;
  }

  const parsedData = ZFieldMetaSchema.safeParse(field.fieldMeta);

  // If it fails, assume the field is optional.
  // This needs to be logged somewhere.
  if (!parsedData.success) {
    return false;
  }

  return parsedData.data?.required === true;
};

/**
 * Whether the provided field is required and not inserted.
 */
export const isFieldUnsignedAndRequired = (
  field: Field,
  recipientRole?: RecipientRole, // REVALLE: recipientRole
) => isRequiredField(field, recipientRole) && !field.inserted;

/**
 * Whether the provided fields contains a field that is required to be inserted.
 */
export const fieldsContainUnsignedRequiredField = (
  fields: Field[],
  recipientRole?: RecipientRole, // REVALLE: recipientRole
) => fields.some((field) => isFieldUnsignedAndRequired(field, recipientRole));
