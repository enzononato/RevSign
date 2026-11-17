import { prisma } from '@documenso/prisma';
import type { Prisma } from '@prisma/client';

import { accountNameKey, isBlankName, nameFromAccount, toAccountNameMap } from '../../../revalle/recipient-name';

type Db = Prisma.TransactionClient;

/**
 * Nomes das contas (e-mail → nome) dos destinatários que chegaram sem nome. Sem destinatário sem nome, nem consulta.
 * Use com `nameFromAccount` na hora de gravar.
 */
export const findAccountNamesFor = async (
  recipients: ReadonlyArray<{ email?: string | null; name?: string | null }>,
  db: Db = prisma,
): Promise<Map<string, string>> => {
  const emails = [
    ...new Set(
      recipients
        .filter((recipient) => isBlankName(recipient.name) && recipient.email?.includes('@'))
        .map((recipient) => accountNameKey(recipient.email ?? '')),
    ),
  ];

  if (emails.length === 0) {
    return new Map();
  }

  const users = await db.user.findMany({
    where: { email: { in: emails, mode: 'insensitive' } },
    select: { email: true, name: true },
  });

  return toAccountNameMap(users);
};

/**
 * Destinatários do envelope sem nome cujo e-mail é de uma conta com nome passam a ter o nome da conta. Nome que já existe
 * nunca é trocado (a gravação confere que continua vazio). Devolve id → nome gravado, para atualizar o que está na
 * memória de quem chamou.
 */
export const fillRecipientNamesFromAccounts = async (envelopeId: string, db: Db = prisma) => {
  const recipients = await db.recipient.findMany({
    where: { envelopeId },
    select: { id: true, email: true, name: true },
  });

  const blank = recipients.filter((recipient) => isBlankName(recipient.name));
  const filled = new Map<number, string>();

  if (blank.length === 0) {
    return filled;
  }

  const accountNames = await findAccountNamesFor(blank, db);

  for (const recipient of blank) {
    const name = nameFromAccount(recipient.name, recipient.email, accountNames);

    if (!name) {
      continue;
    }

    const { count } = await db.recipient.updateMany({
      where: { id: recipient.id, name: recipient.name },
      data: { name },
    });

    if (count > 0) {
      filled.set(recipient.id, name);
    }
  }

  return filled;
};
