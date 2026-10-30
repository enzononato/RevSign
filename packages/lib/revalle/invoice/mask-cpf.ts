export const CPF_MASK = '***.***.***-**';

// "123.456.789-09", "123456789-09" e pontuação parcial ("123.456789-09"): o hífen antes dos 2 dígitos finais é o
// sinal de CPF. Nunca dentro de um número maior (CNPJ de 14 dígitos, chave de acesso de 44).
const CPF_FORMATTED = /(?<![\d.])\d{3}\.?\d{3}\.?\d{3}-\d{2}(?!\d)/g;
// "CPF", "CPF:", "CPF nº", "cpf no", "CPF/CNPJ:" (tomador da NFS-e) seguido de 11 dígitos sem pontuação. Com 14
// dígitos (um CNPJ depois de "CPF/CNPJ") não casa.
const CPF_AFTER_LABEL = /(\bCPF\b(?:\s*\/\s*CNPJ)?[\s:.-]*(?:n[º°o.]?\s*)?)\d{11}(?!\d)/gi;

/**
 * Esconde CPFs do TEXTO da NF antes de mandar ao Gemini. Uma NF escaneada (imagem) vai como está: não há texto para
 * mascarar (ver a política de privacidade e revalle/docs/notas-fiscais.md).
 */
export const maskCpf = (text: string): string =>
  text.replace(CPF_FORMATTED, CPF_MASK).replace(CPF_AFTER_LABEL, (_match, label: string) => `${label}${CPF_MASK}`);
