/** REVALLE (v.26): as 7 unidades, na ordem da tela. O nome também é a chave na base do RH (`RevalleUnit.hrUnitName`). */
export const REVALLE_DEFAULT_UNITS = [
  'Juazeiro',
  'Bonfim',
  'Petrolina',
  'Ribeira do Pombal',
  'Paulo Afonso',
  'Alagoinhas',
  'Serrinha',
] as const;

/** Sem acento, minúsculas, espaços simples. */
export const foldName = (value: string): string =>
  value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * A unidade do RH bate com a unidade do RevSign quando o nome é o mesmo (sem acento nem maiúsculas) ou termina com ele
 * como palavra inteira: "Senhor do Bonfim" é a unidade "Bonfim". "Juazeiro do Norte" não é "Juazeiro".
 */
export const matchesHrUnit = (hrUnidade: string, hrUnitName: string): boolean => {
  const hr = foldName(hrUnidade);
  const unit = foldName(hrUnitName);

  if (!hr || !unit) {
    return false;
  }

  return hr === unit || hr.endsWith(` ${unit}`);
};

/** Setores distintos de uma unidade (nome do primeiro que apareceu; repetidos sem acento ou maiúsculas saem). */
export const setoresForUnit = (pairs: { unidade: string; setor: string }[], hrUnitName: string): string[] => {
  const seen = new Map<string, string>();

  for (const { unidade, setor } of pairs) {
    const name = setor.replace(/\s+/g, ' ').trim();

    if (name && matchesHrUnit(unidade, hrUnitName) && !seen.has(foldName(name))) {
      seen.set(foldName(name), name);
    }
  }

  return [...seen.values()].sort((a, b) => a.localeCompare(b, 'pt-BR'));
};

/** Endereço do time (`/t/<url>`): letras, números e hífen, 3 a 30 caracteres. */
export const slugifyTeamUrl = (value: string): string =>
  foldName(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
