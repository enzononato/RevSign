/** Motivo da troca de conta pelo Financeiro: obrigatório, 10 a 500 caracteres depois de `trim`. */
export const CHANGE_REASON_MIN = 10;
export const CHANGE_REASON_MAX = 500;

export const isValidChangeReason = (reason: string) => {
  const length = reason.trim().length;

  return length >= CHANGE_REASON_MIN && length <= CHANGE_REASON_MAX;
};

export const formatInvoiceAccount = (code: string, name: string | null | undefined) =>
  name ? `${code} – ${name}` : code;

const VERSION_SUFFIX = /\s\(v\d+\)$/;

/** Título da nova versão: título base + " (vN)". O sufixo de uma versão anterior é trocado, nunca empilhado. */
export const nextVersionTitle = (title: string, version: number) =>
  `${title.replace(VERSION_SUFFIX, '')} (v${version})`;

/**
 * Texto exato do aviso da troca (e-mail para o remetente e os destinatários das duas versões). O ponto final do modelo
 * não é dobrado quando o motivo já termina com pontuação.
 */
export const buildAccountChangeNotice = ({
  title,
  from,
  to,
  reason,
}: {
  title: string;
  from: string;
  to: string;
  reason: string;
}) => {
  const text = reason.trim();
  const ending = /[.!?…]$/.test(text) ? '' : '.';

  return `A conta contábil da nota fiscal ${title} foi alterada pelo Financeiro de ${from} para ${to}. Motivo: ${text}${ending}`;
};
