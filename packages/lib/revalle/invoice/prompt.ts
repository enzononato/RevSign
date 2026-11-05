export type InvoicePromptAccount = {
  code: string;
  name: string;
  description: string;
  kind: string | null;
};

const KIND_LABELS: Record<string, string> = { PAYABLE: 'a pagar', RECEIVABLE: 'a receber' };

export const buildInvoicePrompt = (input: { userPrompt: string; accounts: InvoicePromptAccount[] }): string => {
  const accountLines = input.accounts.map((account) => {
    const details = [account.kind ? (KIND_LABELS[account.kind] ?? account.kind) : null, account.description]
      .filter((part) => part)
      .join('; ');

    return details ? `- ${account.code} — ${account.name} (${details})` : `- ${account.code} — ${account.name}`;
  });

  const fixedBlock = [
    'Contas contábeis disponíveis:',
    ...accountLines,
    '',
    'Escolha a conta mais adequada para a nota fiscal enviada, usando somente os códigos da lista acima.',
    'Responda só com JSON, sem texto antes ou depois, neste formato:',
    '{"accountCode": "<código da lista>", "confidence": "alta" | "media" | "baixa", "reason": "<motivo em até 200 caracteres>", "supplierName": "<razão social do emitente, ou null>", "invoiceNumber": "<número da nota, ou null>", "totalAmount": <valor total em reais, número com ponto decimal, ou null>, "accessKey": "<chave de acesso de 44 dígitos, só números, ou null>"}',
    'Copie esses dados do documento. Se um deles não estiver claro, responda null em vez de adivinhar.',
  ].join('\n');

  const userPrompt = input.userPrompt.trim();

  return userPrompt ? `${userPrompt}\n\n${fixedBlock}` : fixedBlock;
};
