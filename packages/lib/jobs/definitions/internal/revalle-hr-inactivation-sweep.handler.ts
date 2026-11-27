import { sweepHrInactivations } from '../../../server-only/revalle/users/hr-inactivation';
import type { JobRunIO } from '../../client/_internal/job';
import type { TRevalleHrInactivationSweepJobDefinition } from './revalle-hr-inactivation-sweep';

// REVALLE (v.26): inativação pela folha. Só contagens no log (nunca CPF, nome ou e-mail).
export const run = async ({ io }: { payload: TRevalleHrInactivationSweepJobDefinition; io: JobRunIO }) => {
  const { unavailable, capped, checked, inactivated, failed } = await sweepHrInactivations();

  if (unavailable) {
    io.logger.warn('HR inactivation sweep: base do RH indisponível, nada foi feito');

    return;
  }

  if (capped) {
    io.logger.warn('HR inactivation sweep: REVALLE_HR_SWEEP_CAP_EXCEEDED, nada foi feito');

    return;
  }

  io.logger.info(
    `HR inactivation sweep: ${checked} conta(s) conferida(s), ${inactivated} inativada(s), ${failed} falha(s)`,
  );
};
