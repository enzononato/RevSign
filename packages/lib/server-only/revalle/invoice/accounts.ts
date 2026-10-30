import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import {
  type AccountsCsvResult,
  decodeCsvBytes,
  type ParsedAccount,
  parseAccountsCsv,
} from '../../../revalle/invoice/accounts-csv';

// Bem acima de um plano de contas real; também mantém o `in (...)` da desativação longe do limite de parâmetros do Postgres.
export const MAX_ACCOUNTS = 5000;

export type AccountsCsvPreview = AccountsCsvResult & { encoding: 'utf-8' | 'windows-1252' };

// Arquivo enviado chega em base64 e é decodificado aqui (UTF-8 estrito, senão Windows-1252, como o Excel salva "CSV").
// Texto colado já é string. Se o texto tiver U+FFFD (arquivo já corrompido antes), o parser devolve o erro em `errors`.
export const previewAccountsCsv = ({ csv, csvBase64 }: { csv?: string; csvBase64?: string }): AccountsCsvPreview => {
  const { text, encoding } =
    csvBase64 !== undefined
      ? decodeCsvBytes(new Uint8Array(Buffer.from(csvBase64, 'base64')))
      : { text: csv ?? '', encoding: 'utf-8' as const };

  const result = parseAccountsCsv(text);

  if (result.accounts.length > MAX_ACCOUNTS) {
    result.errors.push({ line: 1, message: `A lista passa de ${MAX_ACCOUNTS} contas` });
  }

  if (result.errors.length === 0 && result.accounts.length === 0) {
    result.errors.push({ line: 1, message: 'A lista não tem nenhuma conta' });
  }

  return { ...result, encoding };
};

const isSameAccount = (
  current: { name: string; description: string; kind: ParsedAccount['kind']; active: boolean },
  next: ParsedAccount,
) =>
  current.active &&
  current.name === next.name &&
  current.description === next.description &&
  current.kind === next.kind;

// Substitui a lista inteira. Conta que sai fica inativa (documentos antigos continuam mostrando número e nome);
// conta que volta é reativada. `updated` conta só quem mudou (nome, descrição, tipo ou reativação).
export const replaceAccounts = async (
  parsed: ParsedAccount[],
): Promise<{ created: number; updated: number; deactivated: number }> => {
  if (parsed.length === 0 || parsed.length > MAX_ACCOUNTS) {
    throw new AppError(AppErrorCode.INVALID_BODY, { message: 'Lista de contas vazia ou grande demais' });
  }

  return await prisma.$transaction(
    async (tx) => {
      // Duas importações ao mesmo tempo se serializam aqui em vez de misturar as listas.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('revalle_accounting_accounts'))`;

      const existing = await tx.revalleAccountingAccount.findMany({
        select: { id: true, code: true, name: true, description: true, kind: true, active: true },
      });
      const byCode = new Map(existing.map((account) => [account.code, account]));
      const nextCodes = new Set(parsed.map((account) => account.code));

      const toCreate = parsed.filter((account) => !byCode.has(account.code));
      const toUpdate = parsed.filter((account) => {
        const current = byCode.get(account.code);

        return current !== undefined && !isSameAccount(current, account);
      });
      const toDeactivate = existing.filter((account) => account.active && !nextCodes.has(account.code));

      if (toCreate.length > 0) {
        await tx.revalleAccountingAccount.createMany({ data: toCreate });
      }

      for (const account of toUpdate) {
        await tx.revalleAccountingAccount.update({
          where: { code: account.code },
          data: { name: account.name, description: account.description, kind: account.kind, active: true },
        });
      }

      if (toDeactivate.length > 0) {
        await tx.revalleAccountingAccount.updateMany({
          where: { id: { in: toDeactivate.map((account) => account.id) } },
          data: { active: false },
        });
      }

      return { created: toCreate.length, updated: toUpdate.length, deactivated: toDeactivate.length };
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
};

export const findAccounts = async ({
  query,
  includeInactive = false,
  limit,
}: {
  query?: string;
  includeInactive?: boolean;
  limit: number;
}) => {
  const search = query?.trim();

  const where = {
    ...(includeInactive ? {} : { active: true }),
    ...(search
      ? {
          OR: [
            { code: { contains: search, mode: 'insensitive' as const } },
            { name: { contains: search, mode: 'insensitive' as const } },
            { description: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [accounts, total] = await Promise.all([
    prisma.revalleAccountingAccount.findMany({
      where,
      orderBy: [{ active: 'desc' }, { code: 'asc' }],
      take: limit,
      select: { code: true, name: true, description: true, kind: true, active: true },
    }),
    prisma.revalleAccountingAccount.count({ where }),
  ]);

  return { accounts, total };
};
