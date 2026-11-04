import { parseBirthDateInput } from './birth-date';
import { isValidCpf } from './cpf';

/** Os dois campos do cadastro estão preenchidos com um CPF válido e uma data dd/mm/aaaa que existe. */
export const isSignupIdentityFormValid = ({ cpf, birthDate }: { cpf: string; birthDate: string }): boolean =>
  isValidCpf(cpf) && parseBirthDateInput(birthDate) !== null;
