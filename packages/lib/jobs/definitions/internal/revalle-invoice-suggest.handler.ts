import { runInvoiceSuggestion } from '../../../server-only/revalle/invoice/suggest';
import type { JobRunIO } from '../../client/_internal/job';
import type { TRevalleInvoiceSuggestJobDefinition } from './revalle-invoice-suggest';

// REVALLE: nunca lança. Qualquer falha vira FAILED com um código curto (o job não é repetido e a tela não trava).
export const run = async ({ payload, io: _io }: { payload: TRevalleInvoiceSuggestJobDefinition; io: JobRunIO }) => {
  await runInvoiceSuggestion(payload);
};
