export const normalizeCpf = (input: string): string => input.replace(/\D/g, '');

const computeCheckDigit = (digits: number[], weightStart: number): number => {
  const sum = digits.reduce((total, digit, index) => total + digit * (weightStart - index), 0);
  const remainder = (sum * 10) % 11;

  return remainder === 10 ? 0 : remainder;
};

export const isValidCpf = (input: string): boolean => {
  const digits = normalizeCpf(input);

  if (digits.length !== 11) {
    return false;
  }

  if (/^(\d)\1{10}$/.test(digits)) {
    return false;
  }

  const numbers = digits.split('').map(Number);
  const firstCheckDigit = computeCheckDigit(numbers.slice(0, 9), 10);
  const secondCheckDigit = computeCheckDigit(numbers.slice(0, 10), 11);

  return numbers[9] === firstCheckDigit && numbers[10] === secondCheckDigit;
};

export const maskCpf = (input: string): string => {
  const digits = normalizeCpf(input);

  return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;
};
