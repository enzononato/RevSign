export type InvoiceReadyInput = {
  isClassified: boolean;
  /** A consulta do estado falhou: o envio segue, porque o servidor confere de qualquer forma. */
  isError: boolean;
  /** Nova versão de uma troca de conta com o envio do Financeiro em andamento. */
  isHeld: boolean;
  /** Nenhuma conta ativa na lista: nenhuma nota fiscal sai, haja ou não uma escolha antiga. */
  hasNoAccounts: boolean;
  /**
   * `false` na nova versão com o envio parado: o centro de custo só é exigido no primeiro envio da NF, e uma NF enviada
   * sem centro continua podendo ser enviada de novo nessa versão.
   */
  requiresCostCenter?: boolean;
  /** `false` na nova versão de uma correção do centro numa NF marcada depois do envio, que ainda não tem conta. */
  requiresChoice?: boolean;
  /**
   * Fase 8: a pessoa marcou "Sei disso e quero enviar mesmo assim" diante do aviso de nota duplicada. Só pesa quando o
   * estado traz alguma duplicada; a API não pede isso.
   */
  duplicateAcknowledged: boolean;
  state:
    | { isInvoice: 'YES' | 'NO' | 'UNKNOWN'; choice: unknown; costCenter: unknown; duplicates: readonly unknown[] }
    | undefined;
};

/**
 * O bloco "Nota fiscal" do diálogo de envio libera o botão de enviar? NF só sai com a conta e o centro de custo;
 * escaneado (UNKNOWN) só depois da resposta a "É nota fiscal?"; documento comum sai como sempre. Fase 8: NF que parece já
 * ter sido enviada só sai depois da confirmação da pessoa.
 */
export const isInvoiceReady = ({
  isClassified,
  isError,
  isHeld,
  hasNoAccounts,
  requiresCostCenter = true,
  requiresChoice = true,
  duplicateAcknowledged,
  state,
}: InvoiceReadyInput) => {
  if (!isClassified || isHeld || hasNoAccounts) {
    return false;
  }

  if (isError) {
    return true;
  }

  if (!state || state.isInvoice === 'UNKNOWN') {
    return false;
  }

  if (state.isInvoice !== 'YES') {
    return true;
  }

  if (state.duplicates.length > 0 && !duplicateAcknowledged) {
    return false;
  }

  return (!requiresChoice || state.choice !== null) && (!requiresCostCenter || state.costCenter !== null);
};
