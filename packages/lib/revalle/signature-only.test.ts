import { FieldType, RecipientRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  findMissingSignaturesPerItem,
  formatMissingSignaturesMessage,
  getRevalleSignerLabel,
  isRevalleAllowedFieldType,
} from './signature-only';

const signer = (id: number, name: string, role: RecipientRole = RecipientRole.SIGNER) => ({
  id,
  role,
  name,
  email: `p${id}@revalle.com.br`,
});

const items = [
  { id: 'item-1', title: 'contrato.pdf' },
  { id: 'item-2', title: 'aditivo.pdf' },
];

const field = (recipientId: number | null, envelopeItemId: string, type: FieldType = FieldType.SIGNATURE) => ({
  recipientId,
  envelopeItemId,
  type,
});

describe('isRevalleAllowedFieldType', () => {
  it('só aceita SIGNATURE', () => {
    expect(isRevalleAllowedFieldType(FieldType.SIGNATURE)).toBe(true);

    for (const type of Object.values(FieldType).filter((t) => t !== FieldType.SIGNATURE)) {
      expect(isRevalleAllowedFieldType(type)).toBe(false);
    }
  });
});

describe('findMissingSignaturesPerItem', () => {
  it('nada falta quando cada signatário tem assinatura em cada documento', () => {
    const recipients = [signer(1, 'Ana'), signer(2, 'Bruno')];
    const fields = [field(1, 'item-1'), field(1, 'item-2'), field(2, 'item-1'), field(2, 'item-2')];

    expect(findMissingSignaturesPerItem(recipients, items, fields)).toEqual([]);
  });

  it('aponta o par (signatário, documento) que ficou sem assinatura', () => {
    const recipients = [signer(1, 'Ana'), signer(2, 'Bruno')];
    const fields = [field(1, 'item-1'), field(1, 'item-2'), field(2, 'item-1')];

    const missing = findMissingSignaturesPerItem(recipients, items, fields);

    expect(missing.map((m) => [m.recipient.id, m.envelopeItem.id])).toEqual([[2, 'item-2']]);
  });

  it('signatário sem nenhum campo falta em todos os documentos, na ordem dos documentos', () => {
    const missing = findMissingSignaturesPerItem([signer(1, 'Ana')], items, []);

    expect(missing.map((m) => m.envelopeItem.title)).toEqual(['contrato.pdf', 'aditivo.pdf']);
  });

  it('campo de outro tipo não conta como assinatura', () => {
    const fields = [field(1, 'item-1'), field(1, 'item-2', FieldType.NAME)];

    const missing = findMissingSignaturesPerItem([signer(1, 'Ana')], items, fields);

    expect(missing.map((m) => m.envelopeItem.id)).toEqual(['item-2']);
  });

  it('assinatura livre antiga conta como assinatura', () => {
    const fields = [field(1, 'item-1'), field(1, 'item-2', FieldType.FREE_SIGNATURE)];

    expect(findMissingSignaturesPerItem([signer(1, 'Ana')], items, fields)).toEqual([]);
  });

  it('aprovador, visualizador, cópia e assistente não precisam de campo', () => {
    const recipients = [
      signer(1, 'Ana'),
      signer(2, 'Aprovador', RecipientRole.APPROVER),
      signer(3, 'Visualizador', RecipientRole.VIEWER),
      signer(4, 'Cópia', RecipientRole.CC),
      signer(5, 'Assistente', RecipientRole.ASSISTANT),
    ];

    expect(findMissingSignaturesPerItem(recipients, items, [field(1, 'item-1'), field(1, 'item-2')])).toEqual([]);
  });

  it('assinatura de outra pessoa não vale para quem não tem', () => {
    const recipients = [signer(1, 'Ana'), signer(2, 'Bruno')];
    const fields = [field(1, 'item-1'), field(1, 'item-2'), field(null, 'item-1')];

    const missing = findMissingSignaturesPerItem(recipients, [items[0]], fields);

    expect(missing.map((m) => m.recipient.name)).toEqual(['Bruno']);
  });
});

describe('formatMissingSignaturesMessage', () => {
  it('nomeia quem e qual documento', () => {
    const missing = findMissingSignaturesPerItem([signer(1, 'Fulano')], items, [field(1, 'item-1')]);

    expect(formatMissingSignaturesMessage(missing)).toBe(
      'Falta a posição da assinatura de Fulano no documento aditivo.pdf.',
    );
  });

  it('usa o e-mail quando não há nome e junta várias frases', () => {
    const missing = findMissingSignaturesPerItem([signer(7, '  ')], items, []);

    expect(formatMissingSignaturesMessage(missing)).toBe(
      'Falta a posição da assinatura de p7@revalle.com.br no documento contrato.pdf. ' +
        'Falta a posição da assinatura de p7@revalle.com.br no documento aditivo.pdf.',
    );
    expect(getRevalleSignerLabel({ name: '', email: ' x@revalle.com.br ' })).toBe('x@revalle.com.br');
  });
});
