/**
 * Volta ao documento depois de entrar, criar a conta ou confirmar o e-mail (conta obrigatória para o e-mail da empresa).
 *
 * Só aceita o caminho relativo da página de assinatura, `/sign/<token>` (documentos v1 e v2 usam a mesma rota): nada de
 * URL absoluta, `//host`, barra invertida, subcaminho ou parâmetro. Qualquer outra coisa vira null (nenhum redirecionamento
 * aberto).
 */
const SIGNING_PATH = /^\/sign\/([A-Za-z0-9_-]{1,128})$/;

export const sanitizeSigningReturnTo = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  return SIGNING_PATH.test(value) ? value : null;
};

/** O token do caminho de assinatura aceito por `sanitizeSigningReturnTo`, ou null. */
export const tokenOfSigningReturnTo = (value: unknown): string | null => {
  const path = sanitizeSigningReturnTo(value);

  return path ? (SIGNING_PATH.exec(path)?.[1] ?? null) : null;
};

export const signingPathOf = (token: string): string => `/sign/${token}`;

/** Para onde vai quem abre o link sem estar logado: entrar (já tem conta) ou criar a conta, com o e-mail preenchido. */
export const buildRevalleAccountPath = ({
  hasAccount,
  email,
  returnTo,
}: {
  hasAccount: boolean;
  email: string;
  returnTo: string;
}): string => {
  const params = new URLSearchParams({ email: email.trim().toLowerCase(), returnTo });

  return `${hasAccount ? '/signin' : '/signup'}?${params.toString()}`;
};

// O caminho fica guardado no navegador entre o cadastro (ou o login recusado por e-mail não confirmado) e a página que
// confirma o e-mail, que pode abrir em outra aba. Vale 7 dias. Outro aparelho não tem o valor: a pessoa abre o link do
// convite de novo, já com a conta.
const STORAGE_KEY = 'revsign.signingReturnTo';
const STORAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const rememberSigningReturnTo = (value: unknown): void => {
  const path = sanitizeSigningReturnTo(value);

  if (!path || typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ path, savedAt: Date.now() }));
  } catch {
    // Navegador sem armazenamento: a pessoa volta pelo link do convite.
  }
};

export const parseStoredSigningReturnTo = (raw: string | null, now = Date.now()): string | null => {
  if (!raw) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const { path, savedAt } = parsed as { path?: unknown; savedAt?: unknown };

    if (typeof savedAt !== 'number' || savedAt > now || now - savedAt > STORAGE_TTL_MS) {
      return null;
    }

    return sanitizeSigningReturnTo(path);
  } catch {
    return null;
  }
};

/** Lê e apaga o caminho guardado (uma volta só). */
export const takeSigningReturnTo = (): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const path = parseStoredSigningReturnTo(window.localStorage.getItem(STORAGE_KEY));

    window.localStorage.removeItem(STORAGE_KEY);

    return path;
  } catch {
    return null;
  }
};
