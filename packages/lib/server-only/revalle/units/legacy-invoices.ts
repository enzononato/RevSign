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
  type LegacyInvoicePlan,
  type LegacyInvoiceRow,
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

  return planLegacyInvoiceMoves(rows, unitTeamByUser);
};

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
    moveCount: plan.moves.reduce((total, chain) => total + chain.envelopeIds.length, 0),
    movePeopleCount: new Set(plan.moves.map((chain) => chain.ownerUserId)).size,
    stayCount: plan.stays.reduce((total, chain) => total + chain.envelopeIds.length, 0),
    stayPeople: shown.flatMap((owner) => {
      const user = userById.get(owner.userId);

      return user ? [{ userId: user.id, name: user.name, email: user.email, count: owner.count }] : [];
    }),
    stayPeopleCount: stayOwners.length,
  };
};

export type LegacyInvoicesMoveResult = { moved: number; failed: number; stayed: number };

/**
 * Leva as notas antigas para o primeiro time de unidade de quem enviou. Cada cadeia (a nota e as versões dela) numa
 * transação: muda o time, tira da pasta (a pasta é do time antigo) e grava um evento por envelope. Só o que ainda está
 * no pessoal no momento da gravação é levado (rodar de novo não move nada). Uma cadeia que falha não para as outras.
 */
export const moveLegacyInvoices = async ({
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
    stayed: plan.stays.reduce((total, chain) => total + chain.envelopeIds.length, 0),
  };
  const failureCodes = new Map<string, number>();

  for (const chain of plan.moves) {
    try {
      result.moved += await prisma.$transaction(async (tx) => {
        const toTeam = await tx.team.findUniqueOrThrow({
          where: { id: chain.toTeamId },
          select: { id: true, name: true, organisation: { select: { name: true } } },
        });

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
