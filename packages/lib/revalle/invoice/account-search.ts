export type AccountSearchItem = { code: string; name: string };

/** Minúsculas, sem acento e sem espaços nas pontas: "Serviço" e "servico" ficam iguais. */
export const normalizeAccountSearch = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();

const digitsOnly = (value: string) => value.replace(/\D/g, '');

/**
 * Contas cujo número ou nome contém a busca, sem diferenciar acento nem maiúscula. Busca só com números (e pontos,
 * traços ou espaços) também compara só os dígitos: "2103" encontra "2.1.03". Busca vazia devolve todas.
 */
export const searchAccounts = <T extends AccountSearchItem>(accounts: T[], query: string): T[] => {
  const normalized = normalizeAccountSearch(query);

  if (!normalized) {
    return accounts;
  }

  const digits = /^[\d.\s-]+$/.test(normalized) ? digitsOnly(normalized) : '';

  return accounts.filter(
    (account) =>
      normalizeAccountSearch(account.code).includes(normalized) ||
      normalizeAccountSearch(account.name).includes(normalized) ||
      (digits.length > 0 && digitsOnly(account.code).includes(digits)),
  );
};
