import { describe, expect, it } from 'vitest';

import { formatRevalleDateTime } from './date-format';

describe('formatRevalleDateTime', () => {
  it('formata em America/Bahia', () => {
    expect(formatRevalleDateTime(new Date('2026-10-29T17:32:00Z'))).toBe('29/10/2026 14:32');
  });

  it('aceita string ISO', () => {
    expect(formatRevalleDateTime('2026-10-29T17:32:00Z')).toBe('29/10/2026 14:32');
  });

  it('acrescenta o rótulo do fuso', () => {
    expect(formatRevalleDateTime(new Date('2026-10-29T17:32:00Z'), { withZoneLabel: true })).toBe(
      '29/10/2026 14:32 (horário de Brasília)',
    );
  });

  it('vira o dia corretamente (02:30 UTC é 23:30 do dia anterior)', () => {
    expect(formatRevalleDateTime(new Date('2026-01-01T02:30:00Z'))).toBe('31/12/2025 23:30');
  });
});
