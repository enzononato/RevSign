import type { RequestMetadata } from '../../../universal/extract-request-metadata';
import { createRateLimit } from '../../rate-limit/rate-limit';
import { assertRateLimit } from '../../rate-limit/rate-limit-middleware';

const revalleGateRateLimit = createRateLimit({ action: 'revalle.gate', max: 300, window: '15m' });

export const assertRevalleGateRateLimit = async (requestMetadata: RequestMetadata) => {
  assertRateLimit(await revalleGateRateLimit.check({ ip: requestMetadata.ipAddress ?? 'unknown' }));
};
