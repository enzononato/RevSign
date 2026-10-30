export const CPF_MASK = '***.***.***-**';

const CPF_FORMATTED = /(?<![\d.])\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/g;
// "CPF", "CPF:", "CPF nº", "cpf no" seguido de 11 dígitos sem pontuação.
const CPF_AFTER_LABEL = /(\bCPF\b[\s:.-]*(?:n[º°o.]?\s*)?)\d{11}(?!\d)/gi;

/** Esconde CPFs do texto da NF antes de mandar ao Gemini (spec: nunca enviar CPF). */
export const maskCpf = (text: string): string =>
  text.replace(CPF_FORMATTED, CPF_MASK).replace(CPF_AFTER_LABEL, (_match, label: string) => `${label}${CPF_MASK}`);
