import { prisma } from '@documenso/prisma';

import { createPersonalOrganisation } from '../organisation/create-organisation';

const LOCK_ATTEMPTS = 20;
const LOCK_RETRY_MS = 250;

const sleep = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

type Outcome = 'busy' | 'ready' | 'skipped';

/**
 * Conta ativa sem nenhuma organização (membros apagados, conta criada fora do cadastro) ganha a organização pessoal com
 * o time pessoal, como o cadastro faria. Devolve true quando a conta tem organização ao final (criada agora ou por um
 * pedido concorrente), false para conta inexistente, desativada ou criação que falhou.
 *
 * Contra corrida: só quem pega a trava consultiva da transação (por usuário) confere e cria; a contagem de membros é
 * refeita já com a trava, e a criação termina (commit) antes de a trava soltar. Quem não pega a trava solta a conexão,
 * espera um pouco e tenta de novo, então vê a organização pronta em vez de criar outra (e não segura conexões do pool
 * parado na fila).
 */
export const ensurePersonalOrganisation = async ({ userId }: { userId: number }): Promise<boolean> => {
  try {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      const outcome = await prisma.$transaction(
        async (tx): Promise<Outcome> => {
          const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(hashtext('revalle_personal_organisation'), ${userId}::int4) AS locked
          `;

          if (!locked) {
            return 'busy';
          }

          const user = await tx.user.findUnique({ where: { id: userId }, select: { disabled: true } });

          if (!user || user.disabled) {
            return 'skipped';
          }

          if ((await tx.organisationMember.count({ where: { userId } })) > 0) {
            return 'ready';
          }

          // Roda na conexão dela; termina antes de esta transação (e a trava) acabar.
          const organisation = await createPersonalOrganisation({
            userId,
            throwErrorOnOrganisationCreationFailure: true,
          });

          return organisation ? 'ready' : 'skipped';
        },
        { maxWait: 10_000, timeout: 30_000 },
      );

      if (outcome !== 'busy') {
        return outcome === 'ready';
      }

      await sleep(LOCK_RETRY_MS);
    }
  } catch (err) {
    console.error('[revalle] organização pessoal não criada para a conta sem organização', err);
  }

  return false;
};
