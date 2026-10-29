import { normalizeEmail } from '../../revalle/email-domain';
import { logger } from '../../utils/logger';
import { findRevalleRecipientSuggestions, REVALLE_SUGGESTIONS_LIMIT } from './recipient-suggestions';

type Suggestion = { name: string | null; email: string };

export const mergeRevalleRecipientSuggestions = async <T extends Suggestion>(
  upstream: T[],
  query: string,
): Promise<Suggestion[]> => {
  let own: Suggestion[] = [];

  try {
    own = await findRevalleRecipientSuggestions(query);
  } catch (error) {
    logger.error({ msg: '[RevSign] falha nas sugestões por vínculo', error: String(error) });
  }

  const seen = new Set(upstream.map((item) => normalizeEmail(item.email)));
  const extra = own.filter((item) => {
    const key = normalizeEmail(item.email);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });

  return [...upstream, ...extra].slice(0, REVALLE_SUGGESTIONS_LIMIT);
};
