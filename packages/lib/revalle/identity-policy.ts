/**
 * Como o portão de assinatura confere a identidade de quem assina:
 * - `LINKED_EMAIL` (e-mail da empresa): o vínculo e-mail ↔ CPF (ou o e-mail da base do RH) dispensa a tela de CPF; na
 *   primeira confirmação o vínculo nasce, com as checagens de conflito ("CPF ligado a outro e-mail", "e-mail da base
 *   diferente").
 * - `ALWAYS_CPF`: CPF e data de nascimento em TODO documento. O vínculo salvo e o e-mail da base não valem, as checagens
 *   de conflito não se aplicam e nenhum vínculo é criado (o e-mail não vira credencial). Vale para o e-mail de fora da
 *   empresa (`EXTERNAL_EMAIL`, decisão de 16/11/2026) e para o termo do Patrimônio (`PATRIMONIO_TERMO`), que além disso
 *   só aceita o CPF que o Patrimônio informou (`expectedCpf`).
 */
export type RevalleIdentityPolicy =
  | { mode: 'LINKED_EMAIL' }
  | { mode: 'ALWAYS_CPF'; reason: 'EXTERNAL_EMAIL' | 'PATRIMONIO_TERMO'; expectedCpf: string | null };

/** O termo do Patrimônio manda; depois, o domínio do e-mail. */
export const resolveRevalleIdentityPolicy = ({
  isExternalEmail,
  termoCpf,
}: {
  isExternalEmail: boolean;
  termoCpf: string | null;
}): RevalleIdentityPolicy => {
  if (termoCpf !== null) {
    return { mode: 'ALWAYS_CPF', reason: 'PATRIMONIO_TERMO', expectedCpf: termoCpf };
  }

  if (isExternalEmail) {
    return { mode: 'ALWAYS_CPF', reason: 'EXTERNAL_EMAIL', expectedCpf: null };
  }

  return { mode: 'LINKED_EMAIL' };
};
