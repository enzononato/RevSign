import { existsSync } from 'node:fs';
import { isIP } from 'node:net';

import type { CityResponse, Reader } from 'maxmind';

import { env } from '../../utils/env';
import { logger } from '../../utils/logger';

export type IpLocation = { city: string | null; region: string | null; country: string | null };

const DEFAULT_DB_PATH = '/app/geoip/dbip-city-lite.mmdb';

let readerPromise: Promise<Reader<CityResponse> | null> | null = null;
let warned = false;

const warnOnce = (code: string) => {
  if (!warned) {
    warned = true;
    logger.warn({ msg: '[RevSign] geolocalização por IP indisponível', code });
  }
};

const getReader = (): Promise<Reader<CityResponse> | null> => {
  readerPromise ??= (async () => {
    const path = env('NEXT_PRIVATE_REVALLE_GEOIP_DB_PATH') || DEFAULT_DB_PATH;

    try {
      // Arquivo ausente ou o marcador vazio do build (download falhou): segue sem localização.
      if (!existsSync(path)) {
        warnOnce('DB_MISSING');

        return null;
      }

      const { open } = await import('maxmind');

      return await open<CityResponse>(path);
    } catch (error) {
      warnOnce(error instanceof Error ? error.name : 'DB_OPEN_FAILED');

      return null;
    }
  })();

  return readerPromise;
};

/** Loopback, redes privadas, link-local e outros endereços que nunca estão numa base pública. */
export const isNonPublicIp = (ip: string): boolean => {
  const version = isIP(ip);

  if (version === 4) {
    const [a, b] = ip.split('.').map(Number);

    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }

  if (version === 6) {
    const lower = ip.toLowerCase();

    if (lower.startsWith('::ffff:') && isIP(lower.slice(7)) === 4) {
      return isNonPublicIp(lower.slice(7));
    }

    return (
      lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff')
    );
  }

  return true;
};

const pickName = (names?: object) => {
  const map = names as Record<string, string> | undefined;

  return map?.['pt-BR'] ?? map?.en ?? null;
};

export const lookupIpLocation = async (ip: string | undefined): Promise<IpLocation | null> => {
  if (!ip || isNonPublicIp(ip)) {
    return null;
  }

  try {
    const reader = await getReader();
    const result = reader?.get(ip);

    if (!result) {
      return null;
    }

    const subdivision = result.subdivisions?.[0];
    const location: IpLocation = {
      city: pickName(result.city?.names),
      region: subdivision?.iso_code ?? pickName(subdivision?.names),
      country: pickName(result.country?.names) ?? result.country?.iso_code ?? null,
    };

    return location.city || location.region || location.country ? location : null;
  } catch {
    return null;
  }
};
