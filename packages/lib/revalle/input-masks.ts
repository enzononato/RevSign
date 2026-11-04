// Máscaras de digitação dos campos de CPF e data de nascimento. Usadas pelo portão de assinatura e pelo cadastro.
export const formatCpfInput = (value: string): string => {
  const digits = value.replace(/\D/g, '').slice(0, 11);

  return digits
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/^(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4');
};

export const formatBirthDateInput = (value: string): string => {
  const digits = value.replace(/\D/g, '').slice(0, 8);

  return digits.replace(/^(\d{2})(\d)/, '$1/$2').replace(/^(\d{2})\/(\d{2})(\d)/, '$1/$2/$3');
};
