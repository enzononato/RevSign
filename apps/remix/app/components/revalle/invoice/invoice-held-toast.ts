import { msg } from '@lingui/core/macro';

/**
 * "Deixar para o Financeiro": o servidor retém o envio e responde o erro INVOICE_HELD_FOR_FINANCE (nada foi
 * distribuído). Para quem enviou, deu certo: a tela mostra este aviso de sucesso, não o de erro.
 */
export const isInvoiceHeldForFinance = (code: string) => code === 'INVOICE_HELD_FOR_FINANCE';

export const INVOICE_HELD_FOR_FINANCE_TOAST = {
  title: msg`Nota fiscal enviada para o Financeiro`,
  description: msg`Enviado para o Financeiro definir a conta. Os convites saem depois disso.`,
};
