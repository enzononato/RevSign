import { describe, expect, it } from 'vitest';

import { countByOwner, groupInvoiceChains, type LegacyInvoiceRow, planLegacyInvoiceMoves } from './legacy-invoice-plan';

const row = (
  id: string,
  userId: number,
  minute: number,
  links: { previous?: string; supersededBy?: string } = {},
): LegacyInvoiceRow => ({
  id,
  userId,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute)),
  previousEnvelopeId: links.previous ?? null,
  supersededByEnvelopeId: links.supersededBy ?? null,
});

describe('groupInvoiceChains', () => {
  it('junta a nota e as versões dela, em ordem de criação', () => {
    const rows = [
      row('v3', 1, 30, { previous: 'v2' }),
      row('solta', 2, 5),
      row('v1', 1, 10, { supersededBy: 'v2' }),
      row('v2', 1, 20, { previous: 'v1', supersededBy: 'v3' }),
    ];

    expect(groupInvoiceChains(rows).map((chain) => chain.map((item) => item.id))).toEqual([
      ['solta'],
      ['v1', 'v2', 'v3'],
    ]);
  });

  it('ignora a ligação para uma nota que não está na lista', () => {
    const rows = [row('v2', 1, 20, { previous: 'ja-levada' }), row('outra', 1, 25)];

    expect(groupInvoiceChains(rows).map((chain) => chain.map((item) => item.id))).toEqual([['v2'], ['outra']]);
  });

  it('a ligação só de um lado já basta', () => {
    const rows = [row('v1', 1, 10), row('v2', 1, 20, { previous: 'v1' })];

    expect(groupInvoiceChains(rows)).toHaveLength(1);
  });
});

describe('planLegacyInvoiceMoves', () => {
  it('leva para o primeiro time de unidade do dono e deixa quem não está em unidade', () => {
    const rows = [row('a1', 1, 10, { supersededBy: 'a2' }), row('a2', 1, 20, { previous: 'a1' }), row('b1', 2, 15)];
    const plan = planLegacyInvoiceMoves(
      rows,
      new Map([
        [1, 42],
        [2, null],
      ]),
    );

    expect(plan.moves).toEqual([{ envelopeIds: ['a1', 'a2'], ownerUserId: 1, toTeamId: 42 }]);
    expect(plan.stays).toEqual([{ envelopeIds: ['b1'], ownerUserId: 2 }]);
  });

  it('a cadeia inteira vai para o time do dono da primeira versão', () => {
    const rows = [row('v1', 1, 10, { supersededBy: 'v2' }), row('v2', 3, 20, { previous: 'v1' })];
    const plan = planLegacyInvoiceMoves(
      rows,
      new Map([
        [1, 7],
        [3, 9],
      ]),
    );

    expect(plan.moves).toEqual([{ envelopeIds: ['v1', 'v2'], ownerUserId: 1, toTeamId: 7 }]);
  });

  it('dono sem entrada no mapa fica', () => {
    expect(planLegacyInvoiceMoves([row('x', 5, 1)], new Map()).stays).toHaveLength(1);
  });
});

describe('countByOwner', () => {
  it('conta as notas de cada dono, mais notas primeiro', () => {
    expect(
      countByOwner([
        { envelopeIds: ['a'], ownerUserId: 2 },
        { envelopeIds: ['b', 'c'], ownerUserId: 1 },
        { envelopeIds: ['d'], ownerUserId: 2 },
        { envelopeIds: ['e'], ownerUserId: 3 },
      ]),
    ).toEqual([
      { userId: 1, count: 2 },
      { userId: 2, count: 2 },
      { userId: 3, count: 1 },
    ]);
  });
});
