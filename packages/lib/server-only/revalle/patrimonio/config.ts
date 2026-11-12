// REVALLE: integração com o Patrimônio. Configuração por variáveis de ambiente. Sem chave (ou chave curta) a
// integração fica desligada: as rotas respondem 404 e nenhum aviso é gerado.

import { createHash, timingSafeEqual } from 'node:crypto';

import { prisma } from '@documenso/prisma';
import { OrganisationType } from '@prisma/client';

import { env } from '../../../utils/env';
import { logger } from '../../../utils/logger';

export const PATRIMONIO_MIN_KEY_LENGTH = 32;

let warnedShortKey = false;

/** A chave da API, ou null quando a integração está desligada. */
export const getPatrimonioApiKey = (): string | null => {
  const key = env('NEXT_PRIVATE_REVALLE_PATRIMONIO_API_KEY')?.trim();

  if (!key) {
    return null;
  }

  if (key.length < PATRIMONIO_MIN_KEY_LENGTH) {
    if (!warnedShortKey) {
      warnedShortKey = true;
      logger.error({ msg: '[RevSign] Patrimônio: chave com menos de 32 caracteres, integração desligada' });
    }

    return null;
  }

  return key;
};

export const isPatrimonioEnabled = () => getPatrimonioApiKey() !== null;

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/** Confere `Authorization: Bearer <chave>` em tempo constante (compara os SHA-256, que têm sempre o mesmo tamanho). */
export const isPatrimonioAuthorized = (authorization: string | null, key: string): boolean => {
  const match = authorization?.match(/^Bearer\s+(\S+)\s*$/i);

  if (!match) {
    return false;
  }

  return timingSafeEqual(digest(match[1]), digest(key));
};

export type PatrimonioWebhookConfig = { url: string; secret: string };

/** Endereço e segredo dos avisos. Sem um dos dois, nenhum aviso é gerado. O formato do endereço é conferido na entrega. */
export const getPatrimonioWebhookConfig = (): PatrimonioWebhookConfig | null => {
  const url = env('NEXT_PRIVATE_REVALLE_PATRIMONIO_WEBHOOK_URL')?.trim();
  const secret = env('NEXT_PRIVATE_REVALLE_PATRIMONIO_WEBHOOK_SECRET')?.trim();

  if (!url || !secret) {
    return null;
  }

  return { url, secret };
};

export type PatrimonioSender = { userId: number; teamId: number; name: string | null; email: string };

/**
 * A conta de serviço dona dos termos (`NEXT_PRIVATE_REVALLE_PATRIMONIO_SENDER_EMAIL`) e o time pessoal dela. Null quando
 * a variável falta, a conta não existe, está desativada ou não tem time pessoal (o motivo vai para o log, sem dados).
 */
export const getPatrimonioSender = async (): Promise<PatrimonioSender | null> => {
  const email = env('NEXT_PRIVATE_REVALLE_PATRIMONIO_SENDER_EMAIL')?.trim();

  if (!email) {
    logger.error({ msg: '[RevSign] Patrimônio: NEXT_PRIVATE_REVALLE_PATRIMONIO_SENDER_EMAIL não definida' });

    return null;
  }

  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, name: true, email: true, disabled: true },
  });

  if (!user || user.disabled) {
    logger.error({ msg: '[RevSign] Patrimônio: conta remetente inexistente ou desativada' });

    return null;
  }

  const team = await prisma.team.findFirst({
    where: { organisation: { ownerUserId: user.id, type: OrganisationType.PERSONAL } },
    orderBy: { id: 'asc' },
    select: { id: true },
  });

  if (!team) {
    logger.error({ msg: '[RevSign] Patrimônio: conta remetente sem time pessoal', userId: user.id });

    return null;
  }

  return { userId: user.id, teamId: team.id, name: user.name, email: user.email };
};
