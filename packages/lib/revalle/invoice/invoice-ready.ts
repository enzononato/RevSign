export type InvoiceReadyInput = {
  isClassified: boolean;
  /**
   * A consulta do estado falhou e não há estado nenhum: o envio segue, porque o servidor confere de qualquer forma. Se o
   * estado já tinha chegado e foi só o recarregamento que falhou, vale o estado que a pessoa viu (inclusive o aviso de duplicada).
   */
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

  if (isError && !state) {
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

/** Fase 9: o que `isInvoiceFilesReady` lê de cada arquivo do envio (`InvoiceState.documents`). */
export type InvoiceFilesReadyDocument = {
  envelopeItemId: string;
  kind: 'NF' | 'BOLETO' | 'OTHER' | 'UNKNOWN';
  choice: unknown;
  costCenter: unknown;
  duplicates: readonly unknown[];
};

export type InvoiceFilesReadyInput = Omit<InvoiceReadyInput, 'state' | 'duplicateAcknowledged'> & {
  state: { isInvoice: 'YES' | 'NO' | 'UNKNOWN'; documents: readonly InvoiceFilesReadyDocument[] } | undefined;
  /** `envelopeItemId` das notas cujo aviso de duplicada a pessoa marcou ("Sei disso e quero enviar mesmo assim"). */
  acknowledgedDuplicateIds: ReadonlySet<string>;
};

/**
 * Fase 9: o diálogo de envio com várias notas (ou com boleto, ou com arquivo sem texto) libera o botão de enviar? Cada
 * NF só sai com a conta e o centro (como `isInvoiceReady`, por nota) e com o aviso de duplicada dela marcado; arquivo sem
 * texto (UNKNOWN) só depois de a pessoa dizer o tipo. Aviso de boleto e "a mesma nota deste envio" não travam.
 * `isInvoiceReady` continua para o envio de uma nota só (e o editor antigo).
 */
export const isInvoiceFilesReady = ({
  isClassified,
  isError,
  isHeld,
  hasNoAccounts,
  requiresCostCenter = true,
  requiresChoice = true,
  acknowledgedDuplicateIds,
  state,
}: InvoiceFilesReadyInput) => {
  if (!isClassified || isHeld || hasNoAccounts) {
    return false;
  }

  if (isError && !state) {
    return true;
  }

  if (!state || state.isInvoice === 'UNKNOWN' || state.documents.some((doc) => doc.kind === 'UNKNOWN')) {
    return false;
  }

  return state.documents
    .filter((doc) => doc.kind === 'NF')
    .every(
      (doc) =>
        (doc.duplicates.length === 0 || acknowledgedDuplicateIds.has(doc.envelopeItemId)) &&
        (!requiresChoice || doc.choice !== null) &&
        (!requiresCostCenter || doc.costCenter !== null),
    );
};
