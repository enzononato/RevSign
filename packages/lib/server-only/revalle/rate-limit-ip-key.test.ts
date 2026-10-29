import { describe, expect, it } from 'vitest';

import { revalleRateLimitIpKey } from './rate-limit-ip-key';

describe('revalleRateLimitIpKey', () => {
  it('IPv4 fica como está', () => {
    expect(revalleRateLimitIpKey('203.0.113.7')).toBe('203.0.113.7');
  });

  it('IPv6 vira o prefixo /64 (um cliente com uma /64 inteira conta como um só)', () => {
    expect(revalleRateLimitIpKey('2001:db8:1234:5678:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1234:5678::/64');
    expect(revalleRateLimitIpKey('2001:db8:1234:5678::1')).toBe('2001:db8:1234:5678::/64');
    expect(revalleRateLimitIpKey('2001:0DB8:1234:5678:0:0:0:2')).toBe('2001:db8:1234:5678::/64');
  });

  it('IPv6 com :: no prefixo é expandido antes de cortar', () => {
    expect(revalleRateLimitIpKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(revalleRateLimitIpKey('::1')).toBe('0:0:0:0::/64');
    expect(revalleRateLimitIpKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('final IPv4 com pontos conta como dois grupos', () => {
    expect(revalleRateLimitIpKey('2001:db8::5:6:7:1.2.3.4')).toBe('2001:db8:0:5::/64');
    expect(revalleRateLimitIpKey('2001:db8:1:2:3:4:1.2.3.4')).toBe('2001:db8:1:2::/64');
  });

  it('IPv4 mapeado em IPv6 conta como o IPv4', () => {
    expect(revalleRateLimitIpKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('valor que não é IP passa como está', () => {
    expect(revalleRateLimitIpKey('unknown')).toBe('unknown');
  });
});
