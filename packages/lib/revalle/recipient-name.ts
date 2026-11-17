// Nome do destinatário (17/11/2026): quem envia só informa o e-mail. O nome vem da conta (ao gravar) e, no portão, da
// base do RH (a identidade conferida). Funções puras; a gravação fica em server-only/revalle/recipients.

/** Tamanho da coluna `Recipient.name`. */
export const RECIPIENT_NAME_MAX_LENGTH = 255;

const clean = (value: string | null | undefined) => (value ?? '').trim().slice(0, RECIPIENT_NAME_MAX_LENGTH);

export const isBlankName = (value: string | null | undefined) => clean(value) === '';

/** Chave dos mapas de nome por e-mail. */
export const accountNameKey = (email: string) => email.trim().toLowerCase();

/**
 * Nome a gravar: o informado, se houver; senão o da conta do e-mail (mapa de `accountNameKey` → nome já limpo).
 * Nome vazio continua vazio (nunca "null"). Nunca troca um nome que já existe, mesmo que seja de outra conta.
 */
export const nameFromAccount = (
  name: string | null | undefined,
  email: string | null | undefined,
  accountNames: ReadonlyMap<string, string>,
): string => {
  if (!isBlankName(name)) {
    return name ?? '';
  }

  return (email ? accountNames.get(accountNameKey(email)) : undefined) ?? '';
};

/** Mapa e-mail → nome das contas, só com nomes não vazios. */
export const toAccountNameMap = (users: ReadonlyArray<{ email: string; name: string | null }>) => {
  const names = new Map<string, string>();

  for (const user of users) {
    const name = clean(user.name);

    if (name) {
      names.set(accountNameKey(user.email), name);
    }
  }

  return names;
};

/**
 * Troca pelo nome do RH. `null` quando não há o que trocar: RH sem nome ou nome igual ao atual (o portão rodando de
 * novo não gera outro evento). `from` é `null` quando o destinatário ainda não tinha nome.
 */
export const hrNameChange = (
  current: string | null | undefined,
  hrName: string | null | undefined,
): { from: string | null; to: string } | null => {
  const to = clean(hrName);

  if (!to || to === (current ?? '').trim()) {
    return null;
  }

  return { from: isBlankName(current) ? null : (current ?? '').trim(), to };
};

/** Saudação sem nome quebrado ("Olá ,"): o nome, ou o e-mail quando ainda não há nome. */
export const greetingName = (name: string | null | undefined, email: string) =>
  isBlankName(name) ? email : clean(name);
