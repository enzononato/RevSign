import { prisma } from '@documenso/prisma';

import { env } from '../../../utils/env';

// O "flash" mais novo listado nos tipos do @ai-sdk/google 4.0.39 (`GoogleModelId`). Trocar sem novo build:
// NEXT_PRIVATE_REVALLE_GEMINI_MODEL.
export const REVALLE_GEMINI_DEFAULT_MODEL = 'gemini-3.6-flash';

export type RevalleInvoiceAiStatus = 'CONFIGURED' | 'NO_KEY' | 'DISABLED';

const SETTINGS_ID = 1;

// "disabled" vence a chave: o TI desliga a IA sem precisar apagar o segredo do servidor.
export const getRevalleInvoiceAiConfig = (): { status: RevalleInvoiceAiStatus; model: string } => {
  const model = env('NEXT_PRIVATE_REVALLE_GEMINI_MODEL')?.trim() || REVALLE_GEMINI_DEFAULT_MODEL;

  if (env('NEXT_PRIVATE_REVALLE_INVOICE_AI')?.trim().toLowerCase() === 'disabled') {
    return { status: 'DISABLED', model };
  }

  return { status: env('GEMINI_API_KEY')?.trim() ? 'CONFIGURED' : 'NO_KEY', model };
};

export type AccountingSettings = {
  prompt: string;
  accountingEmail: string | null;
  updatedAt: Date | null;
  updatedBy: { name: string | null; email: string } | null;
};

export const getAccountingSettings = async (): Promise<AccountingSettings> => {
  const settings = await prisma.revalleAccountingSettings.findUnique({ where: { id: SETTINGS_ID } });

  if (!settings) {
    return { prompt: '', accountingEmail: null, updatedAt: null, updatedBy: null };
  }

  const updatedBy = settings.updatedById
    ? await prisma.user.findUnique({ where: { id: settings.updatedById }, select: { name: true, email: true } })
    : null;

  return {
    prompt: settings.prompt,
    accountingEmail: settings.accountingEmail,
    updatedAt: settings.updatedAt,
    updatedBy,
  };
};

export const updateAccountingSettings = async ({
  prompt,
  accountingEmail,
  userId,
}: {
  prompt?: string;
  accountingEmail?: string | null;
  userId: number;
}) => {
  const data = {
    ...(prompt !== undefined ? { prompt } : {}),
    ...(accountingEmail !== undefined ? { accountingEmail: accountingEmail?.trim() || null } : {}),
    updatedById: userId,
  };

  await prisma.revalleAccountingSettings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, ...data },
    update: data,
  });
};
