import { prisma } from '@documenso/prisma';

import { normalizeEmail } from '../../revalle/email-domain';
import { logger } from '../../utils/logger';
import { type ColaboradoresRepository, getColaboradoresRepository } from './colaboradores/repository';

export const REVALLE_SUGGESTIONS_LIMIT = 8;
const NAME_LOOKUP_CAP = 20;

type Suggestion = { name: string; email: string };

const fold = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const getRepository = (): ColaboradoresRepository | null => {
  try {
    return getColaboradoresRepository();
  } catch {
    return null;
  }
};

/**
 * Sugere pessoas já vinculadas (e-mail ↔ CPF) pelo e-mail ou pelo nome na base de colaboradores.
 * Nunca expõe CPF; se a base estiver fora do ar, devolve os vínculos sem nome.
 */
export const findRevalleRecipientSuggestions = async (query: string): Promise<Suggestion[]> => {
  const term = fold(query);

  if (!term) {
    return [];
  }

  const repository = getRepository();
  const results = new Map<string, Suggestion>();

  const byEmail = await prisma.revalleEmailLink.findMany({
    where: { email: { contains: normalizeEmail(query), mode: 'insensitive' } },
    orderBy: { createdAt: 'desc' },
    take: REVALLE_SUGGESTIONS_LIMIT,
  });

  const names = new Map<string, string>();

  if (repository) {
    try {
      const people = await repository.searchByName(query, NAME_LOOKUP_CAP);
      const cpfs = people.map((person) => person.cpf);

      for (const person of people) {
        names.set(person.cpf, person.nome);
      }

      const byName = cpfs.length
        ? await prisma.revalleEmailLink.findMany({
            where: { cpf: { in: cpfs } },
            orderBy: { createdAt: 'desc' },
            take: REVALLE_SUGGESTIONS_LIMIT,
          })
        : [];

      for (const link of byName) {
        results.set(link.email, { name: names.get(link.cpf) ?? '', email: link.email });
      }

      const missingNames = byEmail.filter((link) => !names.has(link.cpf)).slice(0, NAME_LOOKUP_CAP);

      await Promise.all(
        missingNames.map(async (link) => {
          try {
            const person = await repository.findByCpf(link.cpf);

            if (person) {
              names.set(link.cpf, person.nome);
            }
          } catch {
            // nome é opcional
          }
        }),
      );
    } catch (error) {
      logger.error({ msg: '[RevSign] base de colaboradores indisponível para sugestões', error: String(error) });
    }
  }

  for (const link of byEmail) {
    if (!results.has(link.email)) {
      results.set(link.email, { name: names.get(link.cpf) ?? '', email: link.email });
    }
  }

  return [...results.values()].slice(0, REVALLE_SUGGESTIONS_LIMIT);
};

/** E-mails vinculados: por vínculo gravado ou porque a base já traz o e-mail. */
export const getRevalleEmailLinkStatus = async (emails: string[]): Promise<{ email: string; isLinked: boolean }[]> => {
  const unique = [...new Set(emails.map(normalizeEmail))];

  const links = await prisma.revalleEmailLink.findMany({
    where: { email: { in: unique } },
    select: { email: true },
  });
  const linked = new Set(links.map((link) => link.email));

  const repository = getRepository();

  if (repository) {
    await Promise.all(
      unique
        .filter((email) => !linked.has(email))
        .map(async (email) => {
          try {
            if (await repository.findByEmail(email)) {
              linked.add(email);
            }
          } catch (error) {
            logger.error({ msg: '[RevSign] base de colaboradores indisponível para vínculos', error: String(error) });
          }
        }),
    );
  }

  return emails.map((email) => ({ email, isLinked: linked.has(normalizeEmail(email)) }));
};
