import {
  MAX_COLLABORATOR_ROWS,
  type ParsedRow,
  parseCollaboratorTable,
  parseCollaboratorText,
} from '@documenso/lib/revalle/collaborator-rows';
import { validateCollaboratorRows } from '@documenso/lib/server-only/revalle/collaborator-contract/validate-rows';
import { isAdmin } from '@documenso/lib/utils/is-admin';
import { prisma } from '@documenso/prisma';
import { TRPCError } from '@trpc/server';

import { authenticatedProcedure } from '../../../trpc';
import { ZPreviewResultSchema, ZPreviewRowsRequestSchema } from './preview-rows.types';

/** REVALLE (v.22): confere a lista de colaboradores (só administrador do sistema). Nada é gravado nem registrado em log. */
export const previewRowsRoute = authenticatedProcedure
  .input(ZPreviewRowsRequestSchema)
  .output(ZPreviewResultSchema)
  .mutation(async ({ ctx, input }) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id }, select: { roles: true } });

    if (!isAdmin(user)) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Só o administrador pode fazer isso.' });
    }

    let parsed: ParsedRow[];

    try {
      parsed = input.text !== undefined ? parseCollaboratorText(input.text) : parseCollaboratorTable(input.rows ?? []);
    } catch (error) {
      if (error instanceof Error && error.message === 'ROW_LIMIT') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `A lista tem mais de ${MAX_COLLABORATOR_ROWS.toLocaleString('pt-BR')} linhas.`,
        });
      }

      throw error;
    }

    return await validateCollaboratorRows(parsed);
  });
