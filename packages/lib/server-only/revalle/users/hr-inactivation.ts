import { prisma } from '@documenso/prisma';
import { RevalleUserStatusAction, RevalleUserStatusSource, Role } from '@prisma/client';

import { normalizeCpf } from '../../../revalle/cpf';
import { env } from '../../../utils/env';
import { disableUser } from '../../user/disable-user';
import { type ColaboradoresRepository, getColaboradoresRepository } from '../colaboradores/repository';
import { revalleErrorCode } from '../error-code';
import { chunk, exceedsHrSweepCap, findDismissedCpfs, HR_SWEEP_CHUNK_SIZE } from './hr-inactivation-rules';

export type HrInactivationResult = {
  /** A base do RH não respondeu (ou não está configurada): ninguém foi tocado. */
  unavailable: boolean;
  /** A noite desativaria mais que o teto (base ou mapeamento suspeito): ninguém foi tocado. */
  capped: boolean;
  checked: number;
  inactivated: number;
  failed: number;
};

type Candidate = { userId: number; cpf: string };

const nothingDone = (checked: number, flags: Partial<Pick<HrInactivationResult, 'unavailable' | 'capped'>> = {}) => ({
  unavailable: false,
  capped: false,
  checked,
  inactivated: 0,
  failed: 0,
  ...flags,
});

/**
 * Contas ativas com CPF vinculado (vínculo e-mail ↔ CPF). `candidates`: sem "Mantido ativo pelo TI" e sem papel de
 * admin do sistema (o admin nunca é desativado pela folha: o TI não pode perder o painel que reativa). `linkedActive`:
 * todas as ativas vinculadas, base do teto de segurança. Contas sem vínculo nunca entram.
 */
const findCandidates = async (): Promise<{ candidates: Candidate[]; linkedActive: number }> => {
  const links = await prisma.revalleEmailLink.findMany({ select: { email: true, cpf: true } });
  const cpfByEmail = new Map(links.map((link) => [link.email.trim().toLowerCase(), normalizeCpf(link.cpf)]));
  const candidates: Candidate[] = [];
  let linkedActive = 0;

  for (const block of chunk([...cpfByEmail.keys()], HR_SWEEP_CHUNK_SIZE)) {
    const users = await prisma.user.findMany({
      where: { disabled: false, email: { in: block, mode: 'insensitive' } },
      select: { id: true, email: true, roles: true, revalleKeepActive: { select: { userId: true } } },
    });

    for (const user of users) {
      const cpf = cpfByEmail.get(user.email.trim().toLowerCase());

      if (!cpf) {
        continue;
      }

      linkedActive += 1;

      if (!user.revalleKeepActive && !user.roles.includes(Role.ADMIN)) {
        candidates.push({ userId: user.id, cpf });
      }
    }
  }

  return { candidates, linkedActive };
};

/** Evento primeiro, depois o "desativar usuário" do upstream: sem evento órfão de conta desativada. */
const inactivate = async (userId: number) => {
  const event = await prisma.revalleUserStatusEvent.create({
    data: { userId, action: RevalleUserStatusAction.INACTIVATED, source: RevalleUserStatusSource.HR_SYNC },
  });

  try {
    await disableUser({ id: userId });
  } catch (error) {
    await prisma.revalleUserStatusEvent.delete({ where: { id: event.id } }).catch(() => undefined);
    throw error;
  }

  // O upstream não encerra as sessões ao desativar; quem saiu da empresa perde o acesso já aberto também.
  // A conta já está desativada (o tRPC ignora sessão de conta desativada): falha aqui só vai para o log.
  await prisma.session.deleteMany({ where: { userId } }).catch((error: unknown) => {
    console.error(`[revalle] Inativação pela folha: sessões não encerradas (${revalleErrorCode(error)}).`);
  });
};

/**
 * REVALLE (v.26): inativação pela folha (rotina noturna). Desativa (com o "desativar usuário" do upstream) as contas
 * cujo CPF vinculado está desligado no RH e registra o evento (INACTIVATED, HR_SYNC). Não faz nada se a base do RH
 * está fora do ar ou se a noite passaria do teto de segurança (`hrSweepCap`). Admins do sistema nunca são desativados.
 * Log só com contagens e códigos de erro: nunca CPF, nome ou e-mail.
 */
export const sweepHrInactivations = async (
  options: { repository?: ColaboradoresRepository | null } = {},
): Promise<HrInactivationResult> => {
  const repository = options.repository === undefined ? getColaboradoresRepository() : options.repository;

  if (!repository) {
    console.error('[revalle] Inativação pela folha: base do RH não configurada. Nada foi feito.');

    return nothingDone(0, { unavailable: true });
  }

  const { candidates, linkedActive } = await findCandidates();

  if (candidates.length === 0) {
    return nothingDone(0);
  }

  let dismissed: Set<string>;

  // Toda a leitura do RH antes de qualquer gravação: se a base cai no meio, ninguém é inativado.
  try {
    dismissed = await findDismissedCpfs(
      repository,
      candidates.map((candidate) => candidate.cpf),
    );
  } catch (error) {
    console.error(
      `[revalle] Inativação pela folha: base do RH indisponível (${revalleErrorCode(error)}). Nada foi feito.`,
    );

    return nothingDone(candidates.length, { unavailable: true });
  }

  const toDisable = candidates.filter((candidate) => dismissed.has(candidate.cpf));

  if (exceedsHrSweepCap(toDisable.length, linkedActive, env('NEXT_PRIVATE_REVALLE_HR_INACTIVATION_MAX'))) {
    console.error('[revalle] Inativação pela folha: REVALLE_HR_SWEEP_CAP_EXCEEDED. Nada foi feito.');

    return nothingDone(candidates.length, { capped: true });
  }

  let inactivated = 0;
  let failed = 0;

  for (const candidate of toDisable) {
    try {
      // O TI pode ter marcado "Mantido ativo" (ou dado admin) depois da leitura: confere de novo antes de desativar.
      const current = await prisma.user.findUnique({
        where: { id: candidate.userId },
        select: { disabled: true, roles: true, revalleKeepActive: { select: { userId: true } } },
      });

      if (!current || current.disabled || current.revalleKeepActive || current.roles.includes(Role.ADMIN)) {
        continue;
      }

      await inactivate(candidate.userId);

      inactivated += 1;
    } catch (error) {
      failed += 1;
      console.error(`[revalle] Inativação pela folha: falha ao desativar uma conta (${revalleErrorCode(error)}).`);
    }
  }

  return { unavailable: false, capped: false, checked: candidates.length, inactivated, failed };
};
