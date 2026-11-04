import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../../errors/app-error';

/**
 * Perfil Contabilidade (Fase 7): tabela própria `RevalleAccountingMember`, marcada pelo admin, igual ao Financeiro. Lido
 * do banco a cada pedido, sem cache: quem sai do perfil perde a visão e as ações na hora.
 */
export const isAccountingMember = async (userId: number): Promise<boolean> => {
  const member = await prisma.revalleAccountingMember.findUnique({ where: { userId }, select: { userId: true } });

  return member !== null;
};

/** Quantos membros a Contabilidade tem (contas desativadas ficam de fora); zero faz a tela do admin avisar. */
export const countAccountingMembers = async (): Promise<number> =>
  await prisma.revalleAccountingMember.count({ where: { user: { disabled: false } } });

/** Marca ou desmarca. Idempotente: marcar quem já é membro mantém quem marcou primeiro; desmarcar quem não é não falha. */
export const setAccountingMember = async ({
  userId,
  isMember,
  adminId,
}: {
  userId: number;
  isMember: boolean;
  adminId: number;
}): Promise<void> => {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });

  if (!user) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Usuário não encontrado.' });
  }

  if (isMember) {
    // ON CONFLICT DO NOTHING: dois cliques ao mesmo tempo não dão erro de chave duplicada.
    await prisma.revalleAccountingMember.createMany({ data: [{ userId, addedById: adminId }], skipDuplicates: true });

    return;
  }

  await prisma.revalleAccountingMember.deleteMany({ where: { userId } });
};
