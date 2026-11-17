import { describe, expect, it } from 'vitest';

import type { InvoiceFilesReadyDocument, InvoiceFilesReadyInput, InvoiceReadyInput } from './invoice-ready';
import { isInvoiceFilesReady, isInvoiceReady } from './invoice-ready';

const account = { code: '2.1.03' };
const costCenter = { code: '101' };
const duplicate = { sentAt: new Date('2026-11-05T12:00:00.000Z'), senderName: 'Maria', status: 'PENDING' as const };

const ready = (overrides: Partial<InvoiceReadyInput> = {}): InvoiceReadyInput => ({
  isClassified: true,
  isError: false,
  isHeld: false,
  hasNoAccounts: false,
  duplicateAcknowledged: false,
  state: { isInvoice: 'YES', choice: account, costCenter, duplicates: [] },
  ...overrides,
});

describe('o bloco da nota fiscal libera o envio', () => {
  it('NF com a conta e o centro libera; faltando um dos dois, não', () => {
    expect(isInvoiceReady(ready())).toBe(true);
    expect(
      isInvoiceReady(ready({ state: { isInvoice: 'YES', choice: account, costCenter: null, duplicates: [] } })),
    ).toBe(false);
    expect(isInvoiceReady(ready({ state: { isInvoice: 'YES', choice: null, costCenter, duplicates: [] } }))).toBe(
      false,
    );
    expect(isInvoiceReady(ready({ state: { isInvoice: 'YES', choice: null, costCenter: null, duplicates: [] } }))).toBe(
      false,
    );
  });

  it('lista de contas vazia bloqueia, mesmo com conta e centro já escolhidos', () => {
    expect(isInvoiceReady(ready({ hasNoAccounts: true }))).toBe(false);
  });

  it('nova versão com o envio parado libera só com a conta: o centro é exigido no primeiro envio', () => {
    const withoutCenter = { isInvoice: 'YES', choice: account, costCenter: null, duplicates: [] } as const;

    expect(isInvoiceReady(ready({ state: withoutCenter, requiresCostCenter: false }))).toBe(true);
    expect(isInvoiceReady(ready({ state: withoutCenter }))).toBe(false);
    expect(
      isInvoiceReady(
        ready({ state: { isInvoice: 'YES', choice: null, costCenter, duplicates: [] }, requiresCostCenter: false }),
      ),
    ).toBe(false);
  });

  it('nova versão de uma NF que ainda não tem conta libera sem ela, só quando a correção do centro pede', () => {
    const withoutAccount = { isInvoice: 'YES', choice: null, costCenter, duplicates: [] } as const;

    expect(isInvoiceReady(ready({ state: withoutAccount, requiresChoice: false, requiresCostCenter: false }))).toBe(
      true,
    );
    expect(isInvoiceReady(ready({ state: withoutAccount, requiresCostCenter: false }))).toBe(false);
  });

  it('documento comum libera sem nada; escaneado só depois da resposta; nova versão com o Financeiro bloqueia', () => {
    expect(isInvoiceReady(ready({ state: { isInvoice: 'NO', choice: null, costCenter: null, duplicates: [] } }))).toBe(
      true,
    );
    expect(
      isInvoiceReady(ready({ state: { isInvoice: 'UNKNOWN', choice: null, costCenter: null, duplicates: [] } })),
    ).toBe(false);
    expect(isInvoiceReady(ready({ isHeld: true }))).toBe(false);
  });

  it('antes da classificação não libera; erro na consulta libera (o servidor confere no envio)', () => {
    expect(isInvoiceReady(ready({ isClassified: false }))).toBe(false);
    expect(isInvoiceReady(ready({ state: undefined }))).toBe(false);
    expect(isInvoiceReady(ready({ state: undefined, isError: true }))).toBe(true);
  });

  it('Fase 8: NF pronta com duplicada só libera depois da confirmação; sem duplicada, a confirmação não importa', () => {
    const withDuplicate = { isInvoice: 'YES', choice: account, costCenter, duplicates: [duplicate] } as const;

    expect(isInvoiceReady(ready({ state: withDuplicate }))).toBe(false);
    expect(isInvoiceReady(ready({ state: withDuplicate, duplicateAcknowledged: true }))).toBe(true);
    expect(isInvoiceReady(ready())).toBe(true);
    expect(isInvoiceReady(ready({ duplicateAcknowledged: true }))).toBe(true);
  });

  it('Fase 8: a confirmação não libera o que já estava bloqueado por outro motivo', () => {
    const base = { isInvoice: 'YES', choice: account, costCenter, duplicates: [duplicate] } as const;
    const acknowledged = { duplicateAcknowledged: true };

    expect(isInvoiceReady(ready({ ...acknowledged, state: { ...base, costCenter: null } }))).toBe(false);
    expect(isInvoiceReady(ready({ ...acknowledged, state: { ...base, choice: null } }))).toBe(false);
    expect(isInvoiceReady(ready({ ...acknowledged, state: base, hasNoAccounts: true }))).toBe(false);
    expect(isInvoiceReady(ready({ ...acknowledged, state: base, isHeld: true }))).toBe(false);
    expect(isInvoiceReady(ready({ ...acknowledged, state: base, isClassified: false }))).toBe(false);
  });

  it('Fase 8: a duplicada vale também na nova versão com o envio parado, e documento comum não pede confirmação', () => {
    const released = { isInvoice: 'YES', choice: account, costCenter: null, duplicates: [duplicate] } as const;

    expect(isInvoiceReady(ready({ state: released, requiresCostCenter: false }))).toBe(false);
    expect(isInvoiceReady(ready({ state: released, requiresCostCenter: false, duplicateAcknowledged: true }))).toBe(
      true,
    );
    expect(isInvoiceReady(ready({ state: { isInvoice: 'NO', choice: null, costCenter: null, duplicates: [] } }))).toBe(
      true,
    );
  });

  it('Fase 8: falha ao recarregar com o estado já carregado não libera o que a duplicada trava', () => {
    const withDuplicate = { isInvoice: 'YES', choice: account, costCenter, duplicates: [duplicate] } as const;

    expect(isInvoiceReady(ready({ state: withDuplicate, isError: true }))).toBe(false);
    expect(isInvoiceReady(ready({ state: withDuplicate, isError: true, duplicateAcknowledged: true }))).toBe(true);
    expect(
      isInvoiceReady(ready({ state: { isInvoice: 'YES', choice: null, costCenter, duplicates: [] }, isError: true })),
    ).toBe(false);
  });
});

describe('Fase 9: o diálogo com várias notas libera o envio', () => {
  const nf = (
    envelopeItemId: string,
    overrides: Partial<InvoiceFilesReadyDocument> = {},
  ): InvoiceFilesReadyDocument => ({
    envelopeItemId,
    kind: 'NF',
    choice: account,
    costCenter,
    duplicates: [],
    ...overrides,
  });
  const file = (envelopeItemId: string, kind: InvoiceFilesReadyDocument['kind']): InvoiceFilesReadyDocument => ({
    envelopeItemId,
    kind,
    choice: null,
    costCenter: null,
    duplicates: [],
  });
  const filesReady = (
    documents: InvoiceFilesReadyDocument[],
    overrides: Partial<InvoiceFilesReadyInput> = {},
  ): InvoiceFilesReadyInput => ({
    isClassified: true,
    isError: false,
    isHeld: false,
    hasNoAccounts: false,
    acknowledgedDuplicateIds: new Set(),
    state: { isInvoice: 'YES', documents },
    ...overrides,
  });

  it('2 notas, a 2ª sem centro, não libera; as duas completas, libera', () => {
    expect(isInvoiceFilesReady(filesReady([nf('a'), nf('b', { costCenter: null })]))).toBe(false);
    expect(isInvoiceFilesReady(filesReady([nf('a'), nf('b', { choice: null })]))).toBe(false);
    expect(isInvoiceFilesReady(filesReady([nf('a'), nf('b')]))).toBe(true);
  });

  it('um arquivo sem texto (UNKNOWN) trava até a pessoa dizer o tipo', () => {
    expect(isInvoiceFilesReady(filesReady([nf('a'), nf('b'), file('s', 'UNKNOWN')]))).toBe(false);
    expect(isInvoiceFilesReady(filesReady([nf('a'), nf('b'), file('s', 'OTHER')]))).toBe(true);
  });

  it('nota com duplicada só libera com o aviso DELA marcado', () => {
    const documents = [nf('a'), nf('b', { duplicates: [duplicate] })];

    expect(isInvoiceFilesReady(filesReady(documents))).toBe(false);
    expect(isInvoiceFilesReady(filesReady(documents, { acknowledgedDuplicateIds: new Set(['a']) }))).toBe(false);
    expect(isInvoiceFilesReady(filesReady(documents, { acknowledgedDuplicateIds: new Set(['b']) }))).toBe(true);
    expect(
      isInvoiceFilesReady(
        filesReady([nf('a'), nf('b', { duplicates: [duplicate], costCenter: null })], {
          acknowledgedDuplicateIds: new Set(['b']),
        }),
      ),
    ).toBe(false);
  });

  it('um boleto (com ou sem aviso) não muda o resultado', () => {
    expect(isInvoiceFilesReady(filesReady([nf('a'), nf('b'), file('boleto', 'BOLETO')]))).toBe(true);
    expect(isInvoiceFilesReady(filesReady([nf('a'), nf('b', { costCenter: null }), file('boleto', 'BOLETO')]))).toBe(
      false,
    );
    expect(isInvoiceFilesReady(filesReady([nf('a'), file('boleto', 'BOLETO')]))).toBe(true);
  });

  it('sem estado: antes da classificação não libera; erro na consulta libera (como hoje)', () => {
    expect(isInvoiceFilesReady(filesReady([nf('a')], { state: undefined }))).toBe(false);
    expect(isInvoiceFilesReady(filesReady([nf('a')], { state: undefined, isError: true }))).toBe(true);
    expect(isInvoiceFilesReady(filesReady([nf('a'), nf('b')], { isClassified: false }))).toBe(false);
  });

  it('lista de contas vazia ou nova versão com o Financeiro bloqueiam; nova versão parada não exige conta nem centro', () => {
    const documents = [nf('a', { costCenter: null }), nf('b', { choice: null, costCenter: null })];

    expect(isInvoiceFilesReady(filesReady([nf('a'), nf('b')], { hasNoAccounts: true }))).toBe(false);
    expect(isInvoiceFilesReady(filesReady([nf('a'), nf('b')], { isHeld: true }))).toBe(false);
    expect(isInvoiceFilesReady(filesReady(documents))).toBe(false);
    expect(isInvoiceFilesReady(filesReady(documents, { requiresChoice: false, requiresCostCenter: false }))).toBe(true);
  });
});
