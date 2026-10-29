// REVALLE: conferência de arquivo no /verificar contra TODAS as versões seladas (Fase 4). Compartilhado cliente/servidor.

/** Uma selagem de um arquivo: hash do PDF selado e quando (já formatado em dd/MM/yyyy HH:mm, horário de Brasília). */
export type RevalleSealedVersion = { sha256: string; sealedAtLabel: string };

export type RevalleSealedMatch = {
  /** Quando foi selada a versão que confere. */
  sealedAtLabel: string;
  /** Selagem mais recente do MESMO arquivo, quando a que confere foi substituída por reselagem; senão null. */
  newerSealedAtLabel: string | null;
};

/**
 * Procura o SHA-256 de um arquivo entre as versões seladas de cada item do envelope.
 * `versions` de cada item vem em ordem cronológica (a última é a atual). Nenhuma confere: null.
 */
export const findSealedVersionMatch = (
  digest: string,
  items: { versions: RevalleSealedVersion[] }[],
): RevalleSealedMatch | null => {
  const wanted = digest.toLowerCase();

  for (const { versions } of items) {
    const index = versions.findIndex((version) => version.sha256.toLowerCase() === wanted);

    if (index !== -1) {
      const latest = versions[versions.length - 1];

      return {
        sealedAtLabel: versions[index].sealedAtLabel,
        newerSealedAtLabel: index < versions.length - 1 ? latest.sealedAtLabel : null,
      };
    }
  }

  return null;
};
