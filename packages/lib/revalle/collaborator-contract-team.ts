// REVALLE (v.22): o time "Contratos para colaboradores" (um por admin, na organização pessoal dele). Fica fora do seletor
// de times de quem não é admin e nunca vira o time do link "Documentos" do menu: os 1.200 documentos de um contrato não
// podem lotar a lista de ninguém. Reconhecido pelo `url` (sem dado pessoal; o id da conta só separa um admin do outro).

export const COLLABORATOR_CONTRACT_TEAM_NAME = 'Contratos para colaboradores';

const TEAM_URL_PREFIX = 'contratos-colab-';

export const collaboratorContractTeamUrl = (userId: number) => `${TEAM_URL_PREFIX}${userId}`;

export const isCollaboratorContractTeamUrl = (url: string | null | undefined): boolean =>
  typeof url === 'string' && /^contratos-colab-\d+$/.test(url);
