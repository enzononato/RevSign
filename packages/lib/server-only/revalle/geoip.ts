import { existsSync, statSync } from 'node:fs';
import { isIP } from 'node:net';

import type { CityResponse, Reader } from 'maxmind';

import { env } from '../../utils/env';
import { logger } from '../../utils/logger';
import { toBrazilianStateCode } from './br-states';

export type IpLocation = {
  city: string | null;
  region: string | null;
  country: string | null;
  countryIso: string | null;
};

const DEFAULT_DB_PATH = '/app/geoip/dbip-city-lite.mmdb';

let readerPromise: Promise<Reader<CityResponse> | null> | null = null;
let warned = false;

const getDbPath = () => env('NEXT_PRIVATE_REVALLE_GEOIP_DB_PATH') || DEFAULT_DB_PATH;

// Um aviso só por processo (na subida, via bootstrap, ou na primeira consulta).
const warnOnce = (code: string) => {
  if (!warned) {
    warned = true;
    logger.warn({
      msg: '[RevSign] geolocalização por IP indisponível: a base DB-IP está ausente, vazia ou ilegível; o certificado mostrará "não identificada" até uma imagem com a base',
      code,
      path: getDbPath(),
    });
  }
};

const getReader = (): Promise<Reader<CityResponse> | null> => {
  readerPromise ??= (async () => {
    const path = getDbPath();

    try {
      // Arquivo ausente ou vazio (marcador do build quando o download falhou): segue sem localização.
      if (!existsSync(path)) {
        warnOnce('DB_MISSING');

        return null;
      }

      if (statSync(path).size === 0) {
        warnOnce('DB_EMPTY');

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

/**
 * Abre a base na subida do app: avisa uma vez no log se ela está ausente ou vazia; senão registra a data da base
 * (DB-IP Lite é mensal e fica congelada na imagem até o próximo build). Nunca lança.
 */
export const checkRevalleGeoIpDatabase = async () => {
  const reader = await getReader();

  if (reader) {
    logger.info({
      msg: '[RevSign] base de geolocalização por IP carregada',
      buildDate: reader.metadata.buildEpoch.toISOString().slice(0, 10),
    });
  }
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
    const countryIso = result.country?.iso_code ?? null;
    const rawRegion = subdivision?.iso_code ?? pickName(subdivision?.names);
    const location: IpLocation = {
      city: pickName(result.city?.names),
      // No Brasil a base traz o nome do estado; o certificado usa a sigla (UF).
      region: countryIso === 'BR' && rawRegion ? toBrazilianStateCode(rawRegion) : rawRegion,
      country: pickName(result.country?.names) ?? countryIso,
      countryIso,
    };

    return location.city || location.region || location.country ? location : null;
  } catch {
    return null;
  }
};
