import type { BoletoData } from './boleto';
import { formatInvoiceAmount } from './invoice-data';

/**
 * Fase 9: conferência do boleto com as notas do mesmo envio. Divergência é só aviso (como a nota duplicada): nunca trava
 * o envio nem a aprovação.
 */
export type BoletoWarning =
  | { code: 'AMOUNT_MISMATCH'; amountCents: number }
  | { code: 'BENEFICIARY_MISMATCH' }
  | { code: 'OVERDUE'; dueDate: string };

export type BoletoCheckInvoice = {
  totalAmountCents: number | null;
  issuerCnpj: string | null;
  supplierName: string | null;
};

/** CNPJ do emitente gravado na chave de acesso (posições 7 a 20). `null` se não é uma chave de 44 dígitos. */
export const issuerCnpjFromAccessKey = (key: string): string | null => (/^\d{44}$/.test(key) ? key.slice(6, 20) : null);

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/**
 * O valor bate se o boleto é igual ao de uma nota ou à soma das notas, ou se a soma dos boletos do envio (parcelas) é
 * igual a uma nota ou à soma. Sem valor no boleto ou em nenhuma nota, não há o que conferir.
 */
const amountMatches = (amountCents: number, otherBoletoAmounts: number[], invoiceAmounts: number[]) => {
  const targets = new Set([...invoiceAmounts, sum(invoiceAmounts)]);

  return targets.has(amountCents) || targets.has(amountCents + sum(otherBoletoAmounts));
};

const normalizeName = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const CNPJ_ROOT_LENGTH = 8;

/**
 * Compara o beneficiário com o emitente de uma nota: pela raiz do CNPJ (a filial é a mesma empresa) quando os dois têm
 * CNPJ; senão pelo nome normalizado (um contém o outro). `null` quando falta dado para comparar.
 */
const sameIssuer = (boleto: BoletoData, invoice: BoletoCheckInvoice): boolean | null => {
  if (boleto.beneficiaryCnpj && invoice.issuerCnpj) {
    return boleto.beneficiaryCnpj.slice(0, CNPJ_ROOT_LENGTH) === invoice.issuerCnpj.slice(0, CNPJ_ROOT_LENGTH);
  }

  const beneficiary = boleto.beneficiaryName ? normalizeName(boleto.beneficiaryName) : '';
  const supplier = invoice.supplierName ? normalizeName(invoice.supplierName) : '';

  if (!beneficiary || !supplier) {
    return null;
  }

  return beneficiary.includes(supplier) || supplier.includes(beneficiary);
};

/**
 * Os avisos de um boleto contra as notas do envio (valor, beneficiário e vencimento, nesta ordem). O beneficiário bate se
 * bater com o emitente de alguma nota; só avisa quando houve com quem comparar. Vencido = vencimento antes de `today`
 * (AAAA-MM-DD, em Brasília).
 */
export const checkBoleto = ({
  boleto,
  otherBoletoAmounts,
  invoices,
  today,
}: {
  boleto: BoletoData;
  otherBoletoAmounts: number[];
  invoices: BoletoCheckInvoice[];
  today: string;
}): BoletoWarning[] => {
  const warnings: BoletoWarning[] = [];
  const invoiceAmounts = invoices
    .map((invoice) => invoice.totalAmountCents)
    .filter((amount): amount is number => amount !== null);

  if (
    boleto.amountCents !== null &&
    invoiceAmounts.length > 0 &&
    !amountMatches(boleto.amountCents, otherBoletoAmounts, invoiceAmounts)
  ) {
    warnings.push({ code: 'AMOUNT_MISMATCH', amountCents: boleto.amountCents });
  }

  const comparisons = invoices
    .map((invoice) => sameIssuer(boleto, invoice))
    .filter((result): result is boolean => result !== null);

  if (comparisons.length > 0 && !comparisons.includes(true)) {
    warnings.push({ code: 'BENEFICIARY_MISMATCH' });
  }

  if (boleto.dueDate !== null && boleto.dueDate < today) {
    warnings.push({ code: 'OVERDUE', dueDate: boleto.dueDate });
  }

  return warnings;
};

const formatDay = (isoDay: string) => isoDay.split('-').reverse().join('/');

export const boletoWarningMessage = (warning: BoletoWarning): string => {
  switch (warning.code) {
    case 'AMOUNT_MISMATCH':
      return `O valor do boleto (${formatInvoiceAmount(warning.amountCents)}) não bate com nenhuma nota do envio.`;
    case 'BENEFICIARY_MISMATCH':
      return 'O beneficiário do boleto é diferente do emitente das notas.';
    case 'OVERDUE':
      return `Boleto vencido em ${formatDay(warning.dueDate)}.`;
  }
};
