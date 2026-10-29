import { env } from '../../utils/env';
import { logger } from '../../utils/logger';

type WindowStr = `${number}${'s' | 'm' | 'h' | 'd'}`;

export type RateLimitOverride = {
  max: number;
  globalMax?: number;
  window: WindowStr;
};

export type ResolvedRateLimitOverrides = {
  overrides: Record<string, RateLimitOverride>;
  invalidEntries: string[];
};

// Os limites do upstream contam por IP, e na Revalle cada unidade sai para a internet
// por um único IP. 3 cadastros a cada 3h travariam a implantação de uma unidade inteira.
// O risco de subir é baixo: só domínios da empresa se cadastram e o e-mail é confirmado.
const REVALLE_DEFAULT_OVERRIDES: Record<string, RateLimitOverride> = {
  'auth.signup': { max: 30, window: '1h' },
};

const ENTRY_PATTERN = /^([a-z0-9.-]+)=(\d+)(?::(\d+))?\/(\d+[smhd])$/;

/**
 * Lê `NEXT_PRIVATE_REVALLE_RATE_LIMITS` no formato `acao=max/janela` ou
 * `acao=max:maxPorIp/janela`, separado por vírgula. Ex.: `auth.login=10:200/15m`.
 *
 * O `maxPorIp` só vale para limites que também contam por identificador (e-mail, token).
 */
export const resolveRateLimitOverrides = (value: string | undefined): ResolvedRateLimitOverrides => {
  const overrides: Record<string, RateLimitOverride> = { ...REVALLE_DEFAULT_OVERRIDES };
  const invalidEntries: string[] = [];

  const entries = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const match = ENTRY_PATTERN.exec(entry);

    if (!match) {
      invalidEntries.push(entry);
      continue;
    }

    const [, action, max, globalMax, window] = match;
    const override: RateLimitOverride = {
      max: Number(max),
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      window: window as WindowStr,
    };

    if (globalMax !== undefined) {
      override.globalMax = Number(globalMax);
    }

    if (override.max === 0 || override.globalMax === 0 || Number.parseInt(window, 10) === 0) {
      invalidEntries.push(entry);
      continue;
    }

    overrides[action] = override;
  }

  return { overrides, invalidEntries };
};

let resolved: ResolvedRateLimitOverrides | null = null;

export const getRateLimitOverride = (action: string): RateLimitOverride | undefined => {
  if (!resolved) {
    resolved = resolveRateLimitOverrides(env('NEXT_PRIVATE_REVALLE_RATE_LIMITS'));

    if (resolved.invalidEntries.length > 0) {
      logger.warn({
        msg: 'NEXT_PRIVATE_REVALLE_RATE_LIMITS: entradas ignoradas',
        invalidEntries: resolved.invalidEntries,
      });
    }
  }

  return resolved.overrides[action];
};
