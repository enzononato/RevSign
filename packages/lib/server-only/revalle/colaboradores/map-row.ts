import { normalizeCpf } from '../../../revalle/cpf';

export type Colaborador = {
  cpf: string;
  nome: string;
  dataNascimento: string;
  cargo: string | null;
  setor: string | null;
  unidade: string | null;
  matricula: string | null;
  email: string | null;
  telefone: string | null;
  situacao: string | null;
};

const toNullableString = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  return String(value);
};

export const mapColaboradorRow = (row: Record<string, unknown>): Colaborador => {
  const email = toNullableString(row.email)?.trim().toLowerCase();

  return {
    cpf: normalizeCpf(String(row.cpf ?? '')),
    nome: String(row.nome ?? ''),
    dataNascimento: String(row.data_nascimento ?? ''),
    cargo: toNullableString(row.cargo),
    setor: toNullableString(row.setor),
    unidade: toNullableString(row.unidade),
    matricula: toNullableString(row.matricula),
    email: email ? email : null,
    telefone: toNullableString(row.telefone),
    situacao: toNullableString(row.situacao),
  };
};
