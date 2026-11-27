/**
 * REVALLE (v.26, Task 7): o plano de "Levar as notas antigas para a unidade de quem enviou", sem banco. Uma nota e as
 * versões dela (nova versão do Financeiro ou da Contabilidade) andam sempre juntas: viram uma cadeia e vão para o mesmo
 * time. Todas as versões têm o mesmo dono; se um dia não tiverem, vale o dono da primeira versão da cadeia.
 */

export type LegacyInvoiceRow = {
  id: string;
  userId: number;
  createdAt: Date;
  previousEnvelopeId: string | null;
  supersededByEnvelopeId: string | null;
};

export type LegacyInvoiceChain = {
  envelopeIds: string[];
  ownerUserId: number;
};

export type LegacyInvoicePlan = {
  /** Cadeias com destino: o primeiro time de unidade do dono. */
  moves: (LegacyInvoiceChain & { toTeamId: number })[];
  /** Cadeias que ficam no espaço pessoal: o dono não está em nenhum time de unidade. */
  stays: LegacyInvoiceChain[];
};

/**
 * Junta as notas ligadas por `previousEnvelopeId`/`supersededByEnvelopeId`. Ligação para uma nota que não está na lista
 * (já levada, apagada de vez) é ignorada. Cada cadeia sai em ordem de criação (a primeira versão na frente).
 */
export const groupInvoiceChains = (rows: LegacyInvoiceRow[]): LegacyInvoiceRow[][] => {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const parent = new Map(rows.map((row) => [row.id, row.id]));

  const find = (id: string): string => {
    let root = id;

    while (parent.get(root) !== root) {
      root = parent.get(root) ?? root;
    }

    let current = id;

    while (current !== root) {
      const next = parent.get(current) ?? root;

      parent.set(current, root);
      current = next;
    }

    return root;
  };

  const union = (a: string, b: string | null) => {
    if (!b || !byId.has(b)) {
      return;
    }

    const rootA = find(a);
    const rootB = find(b);

    if (rootA !== rootB) {
      parent.set(rootB, rootA);
    }
  };

  for (const row of rows) {
    union(row.id, row.previousEnvelopeId);
    union(row.id, row.supersededByEnvelopeId);
  }

  const chains = new Map<string, LegacyInvoiceRow[]>();

  for (const row of rows) {
    const root = find(row.id);
    const chain = chains.get(root) ?? [];

    chain.push(row);
    chains.set(root, chain);
  }

  const byCreation = (a: LegacyInvoiceRow, b: LegacyInvoiceRow) =>
    a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);

  return [...chains.values()].map((chain) => [...chain].sort(byCreation)).sort((a, b) => byCreation(a[0], b[0]));
};

/** Dono da cadeia: o da primeira versão (sem anterior na lista); na falta, o da mais antiga. */
const chainOwner = (chain: LegacyInvoiceRow[]): number => {
  const ids = new Set(chain.map((row) => row.id));
  const first = chain.find((row) => !row.previousEnvelopeId || !ids.has(row.previousEnvelopeId)) ?? chain[0];

  return first.userId;
};

/** `unitTeamByUser`: o primeiro time de unidade de cada dono (`findRevalleUnitTeams`), ou null sem nenhum. */
export const planLegacyInvoiceMoves = (
  rows: LegacyInvoiceRow[],
  unitTeamByUser: ReadonlyMap<number, number | null>,
): LegacyInvoicePlan => {
  const plan: LegacyInvoicePlan = { moves: [], stays: [] };

  for (const chain of groupInvoiceChains(rows)) {
    const ownerUserId = chainOwner(chain);
    const envelopeIds = chain.map((row) => row.id);
    const toTeamId = unitTeamByUser.get(ownerUserId) ?? null;

    if (toTeamId === null) {
      plan.stays.push({ envelopeIds, ownerUserId });
    } else {
      plan.moves.push({ envelopeIds, ownerUserId, toTeamId });
    }
  }

  return plan;
};

/** Os donos distintos de uma lista de cadeias, com quantas notas cada um tem nela (mais notas primeiro). */
export const countByOwner = (chains: LegacyInvoiceChain[]): { userId: number; count: number }[] => {
  const counts = new Map<number, number>();

  for (const chain of chains) {
    counts.set(chain.ownerUserId, (counts.get(chain.ownerUserId) ?? 0) + chain.envelopeIds.length);
  }

  return [...counts.entries()]
    .map(([userId, count]) => ({ userId, count }))
    .sort((a, b) => b.count - a.count || a.userId - b.userId);
};
