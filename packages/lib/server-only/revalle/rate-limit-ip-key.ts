import { isIP } from 'node:net';

// REVALLE: chave de IP para limites por endereço (Fase 4, /verificar). Um cliente IPv6 costuma ter uma /64 inteira;
// contar cada /128 separado deixaria o limite sem efeito. IPv4 (e IPv4 mapeado em IPv6) fica como está.

// Um final IPv4 com pontos (a:b::1.2.3.4) ocupa dois grupos de 16 bits.
const splitGroups = (part: string): string[] => {
  const groups = part.split(':');
  const last = groups[groups.length - 1];

  if (!last.includes('.')) {
    return groups;
  }

  const [a, b, c, d] = last.split('.').map(Number);

  return [...groups.slice(0, -1), ((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
};

const expandIpv6 = (ip: string): string[] | null => {
  const halves = ip.split('::');

  if (halves.length > 2) {
    return null;
  }

  const head = halves[0] ? splitGroups(halves[0]) : [];
  const tail = halves.length === 2 && halves[1] ? splitGroups(halves[1]) : [];
  const missing = 8 - head.length - tail.length;

  if (missing < 0 || (halves.length === 1 && missing !== 0)) {
    return null;
  }

  return [...head, ...Array<string>(missing).fill('0'), ...tail];
};

export const revalleRateLimitIpKey = (ip: string): string => {
  const address = ip.split('%')[0];

  if (isIP(address) !== 6) {
    return ip;
  }

  const lower = address.toLowerCase();

  if (lower.startsWith('::ffff:') && isIP(lower.slice(7)) === 4) {
    return lower.slice(7);
  }

  const groups = expandIpv6(lower);

  if (!groups) {
    return ip;
  }

  const prefix = groups.slice(0, 4).map((group) => Number.parseInt(group, 16).toString(16));

  return `${prefix.join(':')}::/64`;
};
