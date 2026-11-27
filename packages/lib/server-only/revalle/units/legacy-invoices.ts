import { prisma } from '@documenso/prisma';
import { EnvelopeType, OrganisationType, type Prisma, RevalleInvoiceStatus } from '@prisma/client';

import { AppError } from '../../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import type { ApiRequestMetadata } from '../../../universal/extract-request-metadata';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { revalleErrorCode } from '../error-code';
import { findRevalleUnitTeams } from '../visibility/unit-team';
import {
  countByOwner,
  groupInvoiceChains,
  type LegacyInvoicePlan,
  type LegacyInvoiceRow,
  linkedOutsideIds,
  planLegacyInvoiceMoves,
} from './legacy-invoice-plan';

/** Quantas pessoas que ficam a prévia lista (o resto vira "e mais N"). */
export const LEGACY_STAY_PEOPLE_LIMIT = 20;

/**
 * REVALLE (v.26, Task 7): nota antiga do espaço pessoal. "É nota" é o mesmo critério da lista "Notas fiscais" (envelope
 * de documento com a classificação `YES`), em qualquer situação: rascunho, pendente, concluída, recusada, substituída e
 * a excluída pelo remetente (a versão substituída também tem `deletedAt`; levar só parte da cadeia separaria as versões).
 * O que foi apagado de vez já não existe. O time é de uma organização pessoal que não é unidade.
 */
const legacyInvoiceWhere = {
  type: EnvelopeType.DOCUMENT,
  revalleInvoice: { isInvoice: RevalleInvoiceStatus.YES },
  team: { organisation: { type: OrganisationType.PERSONAL, revalleUnit: { is: null } } },
} satisfies Prisma.EnvelopeWhereInput;

const loadPlan = async (): Promise<LegacyInvoicePlan> => {
  const envelopes = await prisma.envelope.findMany({
    where: legacyInvoiceWhere,
    select: {
      id: true,
      userId: true,
      createdAt: true,
      revalleInvoice: { select: { previousEnvelopeId: true, supersededByEnvelopeId: true } },
    },
  });

  const rows: LegacyInvoiceRow[] = envelopes.map((envelope) => ({
    id: envelope.id,
    userId: envelope.userId,
    createdAt: envelope.createdAt,
    previousEnvelopeId: envelope.revalleInvoice?.previousEnvelopeId ?? null,
    supersededByEnvelopeId: envelope.revalleInvoice?.supersededByEnvelopeId ?? null,
  }));

  // O mesmo "primeiro time de unidade" do envio (v.26): menor id, sem o time "Contratos para colaboradores".
  const owners = [...new Set(rows.map((row) => row.userId))];
  const unitTeamByUser = new Map<number, number | null>();

  for (const userId of owners) {
    unitTeamByUser.set(userId, (await findRevalleUnitTeams(userId))[0]?.id ?? null);
  }

  // Versão ligada que já não está na lista (ex.: levada antes): se está num time de unidade, a cadeia vai para lá.
  const outsideIds = [...new Set(groupInvoiceChains(rows).flatMap((chain) => linkedOutsideIds(chain)))];
  const linked = outsideIds.length
    ? await prisma.envelope.findMany({
        where: { id: { in: outsideIds } },
        select: { id: true, teamId: true, team: { select: { organisation: { select: { revalleUnit: true } } } } },
      })
    : [];
  const linkedUnitTeamById = new Map(
    linked.map((envelope) => [envelope.id, envelope.team.organisation.revalleUnit ? envelope.teamId : null]),
  );

  return planLegacyInvoiceMoves(rows, unitTeamByUser, linkedUnitTeamById);
};

const countEnvelopes = (chains: { envelopeIds: string[] }[]) =>
  chains.reduce((total, chain) => total + chain.envelopeIds.length, 0);

export type LegacyInvoicesPreview = {
  /** Notas (envelopes, cada versão conta) que vão para a unidade de quem enviou. */
  moveCount: number;
  /** Pessoas donas dessas notas. */
  movePeopleCount: number;
  /** Notas que ficam: quem enviou não está em nenhum time de unidade. */
  stayCount: number;
  /** Quem fica, para o TI pôr numa unidade (só na tela do admin; nunca em log). */
  stayPeople: { userId: number; name: string | null; email: string; count: number }[];
  stayPeopleCount: number;
  /** Notas que ficam porque as versões delas já estão em times de unidade diferentes (o TI resolve à mão). */
  conflictCount: number;
};

/** Prévia: só consulta, não grava. */
export const previewLegacyInvoices = async (): Promise<LegacyInvoicesPreview> => {
  const plan = await loadPlan();
  const stayOwners = countByOwner(plan.stays);
  const shown = stayOwners.slice(0, LEGACY_STAY_PEOPLE_LIMIT);

  const users = await prisma.user.findMany({
    where: { id: { in: shown.map((owner) => owner.userId) } },
    select: { id: true, name: true, email: true },
  });
  const userById = new Map(users.map((user) => [user.id, user]));

  return {
    moveCount: countEnvelopes(plan.moves),
    movePeopleCount: new Set(plan.moves.map((chain) => chain.ownerUserId)).size,
    stayCount: countEnvelopes(plan.stays),
    stayPeople: shown.flatMap((owner) => {
      const user = userById.get(owner.userId);

      return user ? [{ userId: user.id, name: user.name, email: user.email, count: owner.count }] : [];
    }),
    stayPeopleCount: stayOwners.length,
    conflictCount: countEnvelopes(plan.conflicts),
  };
};

export type LegacyInvoicesMoveResult = {
  moved: number;
  failed: number;
  stayed: number;
  /** Outra chamada já está levando as notas: esta não fez nada. */
  busy: boolean;
};

/** Chave da trava de "Levar as notas antigas" (uma por banco). */
const LEGACY_INVOICES_LOCK_KEY = 'revalle:units:legacy-invoices';

/** Até quanto tempo a trava pode ficar presa (a transação que a segura só espera as cadeias). */
const LEGACY_INVOICES_LOCK_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Leva as notas antigas para o primeiro time de unidade de quem enviou. Uma chamada por vez no banco inteiro: a trava
 * `pg_try_advisory_xact_lock` fica numa transação só dela, aberta até o fim; a segunda chamada (outra aba, outro admin,
 * o clique de novo depois de um tempo esgotado no proxy) volta na hora com `busy` e não move nada. Cada cadeia (a nota e
 * as versões dela) continua numa transação própria: muda o time, tira da pasta (a pasta é do time antigo) e grava um
 * evento por envelope. Só o que ainda está no pessoal no momento da gravação é levado (rodar de novo não move nada).
 * Uma cadeia que falha não para as outras.
 */
export const moveLegacyInvoices = async (options: {
  admin: { id: number; name: string | null; email: string };
  requestMetadata?: ApiRequestMetadata;
}): Promise<LegacyInvoicesMoveResult> =>
  await prisma.$transaction(
    async (lockTx) => {
      const [lock] = await lockTx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext(${LEGACY_INVOICES_LOCK_KEY})) AS locked
      `;

      if (!lock?.locked) {
        console.info('[revalle] Notas antigas do espaço pessoal: já em andamento (REVALLE_LEGACY_INVOICES_BUSY).');

        return { moved: 0, failed: 0, stayed: 0, busy: true };
      }

      return await moveLegacyInvoicesLocked(options);
    },
    { maxWait: 10_000, timeout: LEGACY_INVOICES_LOCK_TIMEOUT_MS },
  );

const moveLegacyInvoicesLocked = async ({
  admin,
  requestMetadata,
}: {
  admin: { id: number; name: string | null; email: string };
  requestMetadata?: ApiRequestMetadata;
}): Promise<LegacyInvoicesMoveResult> => {
  const plan = await loadPlan();
  const result: LegacyInvoicesMoveResult = {
    moved: 0,
    failed: 0,
    stayed: countEnvelopes(plan.stays) + countEnvelopes(plan.conflicts),
    busy: false,
  };
  const failureCodes = new Map<string, number>();

  for (const chain of plan.moves) {
    try {
      result.moved += await prisma.$transaction(async (tx) => {
        const toTeam = await tx.team.findUniqueOrThrow({
          where: { id: chain.toTeamId },
          select: { id: true, name: true, organisation: { select: { name: true, revalleUnit: true } } },
        });

        if (!toTeam.organisation.revalleUnit) {
          throw new AppError('REVALLE_LEGACY_INVOICE_NOT_UNIT');
        }

        const envelopes = await tx.envelope.findMany({
          where: { id: { in: chain.envelopeIds }, ...legacyInvoiceWhere },
          select: { id: true, team: { select: { id: true, name: true } } },
        });

        if (envelopes.length === 0) {
          return 0;
        }

        const { count } = await tx.envelope.updateMany({
          where: { id: { in: envelopes.map((envelope) => envelope.id) }, ...legacyInvoiceWhere },
          data: { teamId: toTeam.id, folderId: null },
        });

        // Outro clique ao mesmo tempo já levou a cadeia: nada a registrar. Só parte dela: desfaz (rodar de novo resolve).
        if (count === 0) {
          return 0;
        }

        if (count !== envelopes.length) {
          throw new AppError('REVALLE_LEGACY_INVOICE_RACE');
        }

        await tx.documentAuditLog.createMany({
          data: envelopes.map((envelope) =>
            createDocumentAuditLogData({
              type: DOCUMENT_AUDIT_LOG_TYPE.REVALLE_INVOICE_MOVED_TO_UNIT,
              envelopeId: envelope.id,
              data: {
                fromTeamId: envelope.team.id,
                fromTeamName: envelope.team.name,
                toTeamId: toTeam.id,
                toTeamName: toTeam.name,
                toUnitName: toTeam.organisation.name,
                movedByUserId: admin.id,
              },
              user: admin,
              metadata: requestMetadata,
            }),
          ),
        });

        return envelopes.length;
      });
    } catch (error) {
      result.failed += chain.envelopeIds.length;

      const code = revalleErrorCode(error);

      failureCodes.set(code, (failureCodes.get(code) ?? 0) + 1);
    }
  }

  // Só contagens e códigos.
  const failures = [...failureCodes.entries()].map(([code, count]) => `${code}:${count}`).join(',');

  console.info(
    `[revalle] Notas antigas do espaço pessoal: ${result.moved} levadas, ${result.stayed} ficam, ${result.failed} com falha${failures ? ` (${failures})` : ''}.`,
  );

  return result;
};
