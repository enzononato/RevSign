import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { previewAccountsCsv, replaceAccounts } from '@documenso/lib/server-only/revalle/invoice/accounts';

import { adminProcedure } from '../../trpc';
import { ZAdminImportAccountsRequestSchema, ZAdminImportAccountsResponseSchema } from './admin-import-accounts.types';

export const adminImportAccountsRoute = adminProcedure
  .input(ZAdminImportAccountsRequestSchema)
  .output(ZAdminImportAccountsResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { accounts, errors } = previewAccountsCsv(input);

    // A lista só é aplicada inteira: com qualquer erro, nada muda (a tela mostra os erros na prévia).
    if (errors.length > 0) {
      throw new AppError(AppErrorCode.INVALID_BODY, {
        message: `A lista tem ${errors.length} erro(s); corrija e envie de novo`,
      });
    }

    const result = await replaceAccounts(accounts);

    ctx.logger.info({ revalleAccounts: result }, 'revalle accounting accounts imported');

    return result;
  });
