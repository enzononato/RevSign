import { describe, expect, it } from 'vitest';

import { matchesHrUnit, setoresForUnit, slugifyTeamUrl } from './names';

describe('matchesHrUnit', () => {
  it('bate pelo nome sem acento nem maiúsculas e pelo fim como palavra inteira', () => {
    expect(matchesHrUnit('JUAZEIRO', 'Juazeiro')).toBe(true);
    expect(matchesHrUnit('Senhor do Bonfim', 'Bonfim')).toBe(true);
    expect(matchesHrUnit('  Ribeira  do Pombal ', 'Ribeira do Pombal')).toBe(true);
    expect(matchesHrUnit('Juazeiro do Norte', 'Juazeiro')).toBe(false);
    expect(matchesHrUnit('Petrolinas', 'Petrolina')).toBe(false);
    expect(matchesHrUnit('', 'Serrinha')).toBe(false);
  });
});

describe('setoresForUnit', () => {
  it('devolve os setores distintos da unidade, em ordem', () => {
    const pairs = [
      { unidade: 'Juazeiro', setor: 'Recursos Humanos' },
      { unidade: 'Juazeiro', setor: 'Administrativo' },
      { unidade: 'juazeiro', setor: 'administrativo' },
      { unidade: 'Petrolina', setor: 'Comercial' },
    ];

    expect(setoresForUnit(pairs, 'Juazeiro')).toEqual(['Administrativo', 'Recursos Humanos']);
    expect(setoresForUnit(pairs, 'Serrinha')).toEqual([]);
  });
});

describe('slugifyTeamUrl', () => {
  it('gera endereço de time válido', () => {
    expect(slugifyTeamUrl('Juazeiro Logística')).toBe('juazeiro-logistica');
    expect(slugifyTeamUrl('Ribeira do Pombal Recursos Humanos')).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(slugifyTeamUrl('Ribeira do Pombal Recursos Humanos').length).toBeLessThanOrEqual(24);
  });
});
