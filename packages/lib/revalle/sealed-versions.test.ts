import { describe, expect, it } from 'vitest';

import { findSealedVersionMatch } from './sealed-versions';

const A1 = 'a'.repeat(64);
const A2 = 'b'.repeat(64);
const A3 = 'c'.repeat(64);
const B1 = 'd'.repeat(64);

const v = (sha256: string, sealedAtLabel: string) => ({ sha256, sealedAtLabel });

describe('findSealedVersionMatch', () => {
  it('a única versão selada confere, sem aviso de versão mais nova', () => {
    expect(findSealedVersionMatch(A1, [{ versions: [v(A1, '29/10/2026 14:30')] }])).toEqual({
      sealedAtLabel: '29/10/2026 14:30',
      newerSealedAtLabel: null,
    });
  });

  it('versão anterior (reselagem) confere e avisa que há uma mais recente', () => {
    const items = [{ versions: [v(A1, '29/10/2026 14:30'), v(A2, '30/10/2026 09:00'), v(A3, '31/10/2026 10:15')] }];

    expect(findSealedVersionMatch(A1, items)).toEqual({
      sealedAtLabel: '29/10/2026 14:30',
      newerSealedAtLabel: '31/10/2026 10:15',
    });
    expect(findSealedVersionMatch(A2, items)).toEqual({
      sealedAtLabel: '30/10/2026 09:00',
      newerSealedAtLabel: '31/10/2026 10:15',
    });
    expect(findSealedVersionMatch(A3, items)).toEqual({
      sealedAtLabel: '31/10/2026 10:15',
      newerSealedAtLabel: null,
    });
  });

  it('vários arquivos: a versão mais nova é a do mesmo arquivo', () => {
    const items = [
      { versions: [v(A1, '29/10/2026 14:30'), v(A2, '30/10/2026 09:00')] },
      { versions: [v(B1, '29/10/2026 14:30')] },
    ];

    expect(findSealedVersionMatch(B1, items)).toEqual({ sealedAtLabel: '29/10/2026 14:30', newerSealedAtLabel: null });
    expect(findSealedVersionMatch(A1, items)?.newerSealedAtLabel).toBe('30/10/2026 09:00');
  });

  it('nada confere: null (a página mostra "diferente")', () => {
    expect(findSealedVersionMatch('e'.repeat(64), [{ versions: [v(A1, '29/10/2026 14:30')] }])).toBeNull();
    expect(findSealedVersionMatch(A1, [])).toBeNull();
    expect(findSealedVersionMatch(A1, [{ versions: [] }])).toBeNull();
  });

  it('compara sem diferenciar maiúsculas do hex', () => {
    expect(findSealedVersionMatch(A1.toUpperCase(), [{ versions: [v(A1, '29/10/2026 14:30')] }])).not.toBeNull();
  });
});
