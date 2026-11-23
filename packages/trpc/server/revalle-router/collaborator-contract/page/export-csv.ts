import { exportCollaboratorContractPageCsv } from '@documenso/lib/server-only/revalle/collaborator-contract/page-tracking';

import {
  ZExportCollaboratorContractCsvRequestSchema,
  ZExportCollaboratorContractCsvResponseSchema,
} from './export-csv.types';
import { collaboratorContractPageProcedure } from './page-procedure';

/** "Baixar situação". */
export const exportCollaboratorContractCsvRoute = collaboratorContractPageProcedure
  .input(ZExportCollaboratorContractCsvRequestSchema)
  .output(ZExportCollaboratorContractCsvResponseSchema)
  .mutation(async ({ ctx, input }) => {
    const { contractId } = input;

    return await exportCollaboratorContractPageCsv({ userId: ctx.user.id, contractId });
  });
