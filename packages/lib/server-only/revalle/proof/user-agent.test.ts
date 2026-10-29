import { describe, expect, it } from 'vitest';

import { describeUserAgent, UNKNOWN_DEVICE } from './user-agent';

describe('describeUserAgent', () => {
  it('descreve Android com Chrome', () => {
    const text = describeUserAgent(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    );

    expect(text).toContain('Android 14');
    expect(text).toContain('Chrome 130');
  });

  it('descreve Windows com Edge', () => {
    const text = describeUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
    );

    expect(text).toContain('Windows');
    expect(text).toContain('Edge 129');
  });

  it('cai no texto padrão quando não há como identificar', () => {
    expect(describeUserAgent('')).toBe(UNKNOWN_DEVICE);
    expect(describeUserAgent(undefined)).toBe(UNKNOWN_DEVICE);
    expect(describeUserAgent('curl')).toBe(UNKNOWN_DEVICE);
  });
});
