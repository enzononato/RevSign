import { z } from 'zod';

import { ZContractIdSchema } from './shared.types';

export const ZExportCollaboratorContractCsvRequestSchema = z.object({ contractId: ZContractIdSchema });

export const ZExportCollaboratorContractCsvResponseSchema = z.object({
  /** nome;email;CPF;situação;data, com BOM (Excel em português); CPF mascarado. */
  csv: z.string(),
  rowCount: z.number(),
});
