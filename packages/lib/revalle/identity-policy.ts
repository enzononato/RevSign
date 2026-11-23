/**
 * Como o portão de assinatura confere a identidade de quem assina:
 * - `LINKED_EMAIL` (e-mail da empresa): o vínculo e-mail ↔ CPF (ou o e-mail da base do RH) dispensa a tela de CPF; na
 *   primeira confirmação o vínculo nasce, com as checagens de conflito ("CPF ligado a outro e-mail", "e-mail da base
 *   diferente").
 * - `ALWAYS_CPF`: CPF e data de nascimento em TODO documento. O vínculo salvo e o e-mail da base não valem, as checagens
 *   de conflito não se aplicam e nenhum vínculo é criado (o e-mail não vira credencial). Vale para o e-mail de fora da
 *   empresa (`EXTERNAL_EMAIL`, decisão de 16/11/2026) e para o termo do Patrimônio (`PATRIMONIO_TERMO`), que além disso
 *   só aceita o CPF que o Patrimônio informou (`expectedCpf`).
 * - v.21, contrato para colaboradores (documento sem conta): no e-mail da empresa, `LINKED_EMAIL` com
 *   `askCpfEveryTime`: o vínculo salvo e o e-mail da base NÃO dispensam a tela de CPF (o link chega sem conta), mas as
 *   conferências do e-mail da empresa continuam (conflito com o vínculo e com o e-mail da base; o vínculo nasce na
 *   primeira confirmação). No e-mail de fora, `ALWAYS_CPF` como sempre.
 */
export type RevalleIdentityPolicy =
  | { mode: 'LINKED_EMAIL'; askCpfEveryTime?: true }
  | { mode: 'ALWAYS_CPF'; reason: 'EXTERNAL_EMAIL' | 'PATRIMONIO_TERMO'; expectedCpf: string | null };

/** O termo do Patrimônio manda; depois, o domínio do e-mail; por último, o contrato para colaboradores. */
export const resolveRevalleIdentityPolicy = ({
  isExternalEmail,
  termoCpf,
  isCollaboratorContract = false,
}: {
  isExternalEmail: boolean;
  termoCpf: string | null;
  isCollaboratorContract?: boolean;
}): RevalleIdentityPolicy => {
  if (termoCpf !== null) {
    return { mode: 'ALWAYS_CPF', reason: 'PATRIMONIO_TERMO', expectedCpf: termoCpf };
  }

  if (isExternalEmail) {
    return { mode: 'ALWAYS_CPF', reason: 'EXTERNAL_EMAIL', expectedCpf: null };
  }

  return isCollaboratorContract ? { mode: 'LINKED_EMAIL', askCpfEveryTime: true } : { mode: 'LINKED_EMAIL' };
};

/** O e-mail (vínculo salvo ou e-mail da base) dispensa a tela de CPF só no `LINKED_EMAIL` comum. */
export const revalleIdentityAsksCpfEveryTime = (policy: RevalleIdentityPolicy): boolean =>
  policy.mode === 'ALWAYS_CPF' || policy.askCpfEveryTime === true;
