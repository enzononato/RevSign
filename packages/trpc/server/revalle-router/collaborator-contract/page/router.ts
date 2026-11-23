import { router } from '../../../trpc';
import { createCollaboratorContractRoute } from './create';
import { exportCollaboratorContractCsvRoute } from './export-csv';
import { getCollaboratorContractRoute } from './get';
import { listCollaboratorContractsRoute } from './list';
import { previewRowsRoute } from './preview-rows';
import { resendCollaboratorInviteRoute } from './resend';
import { resendCollaboratorContractRepresentativeRoute } from './resend-representative';
import { findCollaboratorContractRowsRoute } from './rows';
import { saveCollaboratorContractDraftRoute } from './save-draft';
import { setCollaboratorContractPausedRoute } from './set-paused';

// REVALLE (v.22): `revalle.collaboratorContract.page.*`, a página "Contratos para colaboradores" (só administrador).
export const collaboratorContractPageRouter = router({
  create: createCollaboratorContractRoute,
  saveDraft: saveCollaboratorContractDraftRoute,
  list: listCollaboratorContractsRoute,
  get: getCollaboratorContractRoute,
  rows: findCollaboratorContractRowsRoute,
  resend: resendCollaboratorInviteRoute,
  resendRepresentative: resendCollaboratorContractRepresentativeRoute,
  setPaused: setCollaboratorContractPausedRoute,
  exportCsv: exportCollaboratorContractCsvRoute,
  previewRows: previewRowsRoute,
});
