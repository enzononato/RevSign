/**
 * Só o código (ou o tipo) do erro, para log. A mensagem de erro pode trazer e-mail, CPF ou dados da conexão.
 */
export const revalleErrorCode = (error: unknown): string => {
  if (error instanceof Error) {
    const { code } = error as Error & { code?: unknown };

    return typeof code === 'string' || typeof code === 'number' ? String(code) : error.name;
  }

  return 'unknown';
};
