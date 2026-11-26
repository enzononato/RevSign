const STORAGE_PREFIX = 'revalle:self-signer-prefill:';

// Sem o armazenamento do navegador (aba anônima, bloqueado): vale ao menos enquanto a página está aberta.
const claimedInMemory = new Set<string>();

/**
 * O rascunho novo recebe quem o criou como primeiro signatário uma vez só: `true` na primeira vez para este envelope
 * (neste navegador), `false` depois. Quem se removeu da lista não volta ao reabrir o rascunho.
 */
export const claimSelfSignerPrefill = (envelopeId: string): boolean => {
  if (claimedInMemory.has(envelopeId)) {
    return false;
  }

  claimedInMemory.add(envelopeId);

  try {
    const key = `${STORAGE_PREFIX}${envelopeId}`;

    if (window.localStorage.getItem(key)) {
      return false;
    }

    window.localStorage.setItem(key, '1');
  } catch {
    // Sem armazenamento: fica só a marca em memória.
  }

  return true;
};
