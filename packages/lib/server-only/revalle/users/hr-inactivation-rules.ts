import { isInactiveSituacao } from '../../../revalle/collaborator-rows';
import type { ColaboradoresRepository } from '../colaboradores/repository';

/**
 * REVALLE (v.26): regras puras da inativação pela folha (sem banco do RevSign), cobertas por Vitest.
 */

export const HR_SWEEP_CHUNK_SIZE = 500;

/** Mínimo de contas que uma noite pode desativar antes da trava (o teto é o maior entre este e 5% dos vinculados). */
export const HR_SWEEP_CAP_MIN = 10;
export const HR_SWEEP_CAP_RATIO = 0.05;

export const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
};

/**
 * Quantas contas uma noite pode desativar. Padrão: max(10, 5% das contas ativas vinculadas, arredondado para cima).
 * `override` (NEXT_PRIVATE_REVALLE_HR_INACTIVATION_MAX) troca o teto por um número fixo; vazio ou inválido = padrão.
 */
export const hrSweepCap = (linkedActive: number, override?: string | null): number => {
  const trimmed = override?.trim();

  if (trimmed && /^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }

  return Math.max(HR_SWEEP_CAP_MIN, Math.ceil(Math.max(0, linkedActive) * HR_SWEEP_CAP_RATIO));
};

/** Trava de segurança: desativar mais que o teto numa noite indica base ou mapeamento errado; ninguém é desativado. */
export const exceedsHrSweepCap = (toDisable: number, linkedActive: number, override?: string | null): boolean =>
  toDisable > hrSweepCap(linkedActive, override);

/**
 * CPFs que a base do RH mostra como desligados. Um CPF com mais de uma linha (readmissão) só conta como desligado se
 * TODAS as linhas forem de saída; CPF ausente da base não conta. Erro em qualquer bloco: lança (quem chama não grava).
 */
export const findDismissedCpfs = async (
  repository: Pick<ColaboradoresRepository, 'findManyByCpf'>,
  cpfs: string[],
): Promise<Set<string>> => {
  const inactive = new Set<string>();
  const active = new Set<string>();

  for (const block of chunk([...new Set(cpfs)], HR_SWEEP_CHUNK_SIZE)) {
    for (const colaborador of await repository.findManyByCpf(block)) {
      (isInactiveSituacao(colaborador.situacao) ? inactive : active).add(colaborador.cpf);
    }
  }

  return new Set([...inactive].filter((cpf) => !active.has(cpf)));
};
