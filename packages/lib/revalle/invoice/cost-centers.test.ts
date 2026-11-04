import { describe, expect, it } from 'vitest';

import { costCenterLabel, isCostCenterCode, REVALLE_COST_CENTERS } from './cost-centers';

describe('centros de custo', () => {
  it('a lista fixa tem os cinco centros, na ordem do código', () => {
    expect(REVALLE_COST_CENTERS.map((c) => c.code)).toEqual(['101', '201', '301', '401', '501']);
    expect(REVALLE_COST_CENTERS.map((c) => c.name)).toEqual([
      'Puxada',
      'Armazém',
      'Administrativo',
      'Vendas',
      'Entrega',
    ]);
  });

  it('o rótulo junta código e nome, e o código desconhecido volta como veio', () => {
    expect(costCenterLabel('101')).toBe('101 – Puxada');
    expect(costCenterLabel('201')).toBe('201 – Armazém');
    expect(costCenterLabel('999')).toBe('999');
    expect(costCenterLabel('')).toBe('');
  });

  it('só os cinco códigos da lista valem', () => {
    expect(isCostCenterCode('301')).toBe(true);
    expect(isCostCenterCode('302')).toBe(false);
    expect(isCostCenterCode(' 101')).toBe(false);
    expect(isCostCenterCode(101)).toBe(false);
    expect(isCostCenterCode(null)).toBe(false);
    expect(isCostCenterCode(undefined)).toBe(false);
  });
});
