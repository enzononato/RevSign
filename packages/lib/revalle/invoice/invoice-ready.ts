export type InvoiceReadyInput = {
  isClassified: boolean;
  /** A consulta do estado falhou: o envio segue, porque o servidor confere de qualquer forma. */
  isError: boolean;
  /** Nova versão de uma troca de conta com o envio do Financeiro em andamento. */
  isHeld: boolean;
  /** Nenhuma conta ativa na lista: nenhuma nota fiscal sai, haja ou não uma escolha antiga. */
  hasNoAccounts: boolean;
  /**
   * `false` na nova versão de uma troca de conta com o envio parado (reserva solta): o centro de custo só é exigido no
   * primeiro envio da NF, e uma NF enviada sem centro continua podendo ser enviada de novo nessa versão.
   */
  requiresCostCenter?: boolean;
  state: { isInvoice: 'YES' | 'NO' | 'UNKNOWN'; choice: unknown; costCenter: unknown } | undefined;
};

/**
 * O bloco "Nota fiscal" do diálogo de envio libera o botão de enviar? NF só sai com a conta e o centro de custo;
 * escaneado (UNKNOWN) só depois da resposta a "É nota fiscal?"; documento comum sai como sempre.
 */
export const isInvoiceReady = ({
  isClassified,
  isError,
  isHeld,
  hasNoAccounts,
  requiresCostCenter = true,
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

  return state.isInvoice !== 'YES' || (state.choice !== null && (!requiresCostCenter || state.costCenter !== null));
};
