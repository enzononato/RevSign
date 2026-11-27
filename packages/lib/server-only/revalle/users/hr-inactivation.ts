import { prisma } from '@documenso/prisma';
import { RevalleUserStatusAction, RevalleUserStatusSource } from '@prisma/client';

import { isInactiveSituacao } from '../../../revalle/collaborator-rows';
import { normalizeCpf } from '../../../revalle/cpf';
import { disableUser } from '../../user/disable-user';
import { type ColaboradoresRepository, getColaboradoresRepository } from '../colaboradores/repository';
import { revalleErrorCode } from '../error-code';

const CHUNK_SIZE = 500;

const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
};

export type HrInactivationResult = {
  /** A base do RH não respondeu (ou não está configurada): ninguém foi tocado. */
  unavailable: boolean;
  checked: number;
  inactivated: number;
  failed: number;
};

type Candidate = { userId: number; cpf: string };

/**
 * Contas ativas com CPF vinculado (vínculo e-mail ↔ CPF) e sem a marca "Mantido ativo pelo TI".
 * Contas sem vínculo nunca entram.
 */
const findCandidates = async (): Promise<Candidate[]> => {
  const links = await prisma.revalleEmailLink.findMany({ select: { email: true, cpf: true } });
  const cpfByEmail = new Map(links.map((link) => [link.email.trim().toLowerCase(), normalizeCpf(link.cpf)]));
  const candidates: Candidate[] = [];

  for (const block of chunk([...cpfByEmail.keys()], CHUNK_SIZE)) {
    const users = await prisma.user.findMany({
      where: {
        disabled: false,
        revalleKeepActive: null,
        email: { in: block, mode: 'insensitive' },
      },
      select: { id: true, email: true },
    });

    for (const user of users) {
      const cpf = cpfByEmail.get(user.email.trim().toLowerCase());

      if (cpf) {
        candidates.push({ userId: user.id, cpf });
      }
    }
  }

  return candidates;
};

/**
 * CPFs que a base do RH mostra como desligados. Um CPF com mais de uma linha (readmissão) só conta como desligado se
 * TODAS as linhas forem de saída; CPF ausente da base não conta. Erro em qualquer bloco: lança (quem chama não grava).
 */
const findDismissedCpfs = async (repository: ColaboradoresRepository, cpfs: string[]): Promise<Set<string>> => {
  const inactive = new Set<string>();
  const active = new Set<string>();

  for (const block of chunk([...new Set(cpfs)], CHUNK_SIZE)) {
    for (const colaborador of await repository.findManyByCpf(block)) {
      (isInactiveSituacao(colaborador.situacao) ? inactive : active).add(colaborador.cpf);
    }
  }

  return new Set([...inactive].filter((cpf) => !active.has(cpf)));
};

/**
 * REVALLE (v.26): inativação pela folha (rotina noturna). Desativa (com o "desativar usuário" do upstream) as contas
 * cujo CPF vinculado está desligado no RH e registra o evento (INACTIVATED, HR_SYNC). Base fora do ar: não faz nada.
 * Log só com contagens e códigos de erro: nunca CPF, nome ou e-mail.
 */
export const sweepHrInactivations = async (
  options: { repository?: ColaboradoresRepository | null } = {},
): Promise<HrInactivationResult> => {
  const repository = options.repository === undefined ? getColaboradoresRepository() : options.repository;

  if (!repository) {
    console.error('[revalle] Inativação pela folha: base do RH não configurada. Nada foi feito.');

    return { unavailable: true, checked: 0, inactivated: 0, failed: 0 };
  }

  const candidates = await findCandidates();

  if (candidates.length === 0) {
    return { unavailable: false, checked: 0, inactivated: 0, failed: 0 };
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

    return { unavailable: true, checked: candidates.length, inactivated: 0, failed: 0 };
  }

  let inactivated = 0;
  let failed = 0;

  for (const candidate of candidates) {
    if (!dismissed.has(candidate.cpf)) {
      continue;
    }

    try {
      // O TI pode ter marcado "Mantido ativo" depois da leitura: confere de novo antes de desativar.
      const current = await prisma.user.findUnique({
        where: { id: candidate.userId },
        select: { disabled: true, revalleKeepActive: { select: { userId: true } } },
      });

      if (!current || current.disabled || current.revalleKeepActive) {
        continue;
      }

      await disableUser({ id: candidate.userId });

      // O upstream não encerra as sessões ao desativar; quem saiu da empresa perde o acesso já aberto também.
      await prisma.session.deleteMany({ where: { userId: candidate.userId } });

      await prisma.revalleUserStatusEvent.create({
        data: {
          userId: candidate.userId,
          action: RevalleUserStatusAction.INACTIVATED,
          source: RevalleUserStatusSource.HR_SYNC,
        },
      });

      inactivated += 1;
    } catch (error) {
      failed += 1;
      console.error(`[revalle] Inativação pela folha: falha ao desativar uma conta (${revalleErrorCode(error)}).`);
    }
  }

  return { unavailable: false, checked: candidates.length, inactivated, failed };
};
