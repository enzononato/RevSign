import { describe, expect, it } from 'vitest';

import { roundGeolocation, ZRevalleGeolocationSchema } from './geolocation';

describe('ZRevalleGeolocationSchema', () => {
  it('aceita os três estados', () => {
    expect(ZRevalleGeolocationSchema.safeParse({ status: 'DENIED' }).success).toBe(true);
    expect(ZRevalleGeolocationSchema.safeParse({ status: 'UNAVAILABLE' }).success).toBe(true);
    expect(
      ZRevalleGeolocationSchema.safeParse({ status: 'GRANTED', lat: -12.97, lon: -38.5, accuracyM: 20 }).success,
    ).toBe(true);
  });

  it('rejeita fora de faixa, NaN, Infinity e NOT_REQUESTED', () => {
    const bad = [
      { status: 'GRANTED', lat: 200, lon: 0, accuracyM: 1 },
      { status: 'GRANTED', lat: 0, lon: -181, accuracyM: 1 },
      { status: 'GRANTED', lat: 0, lon: 0, accuracyM: -1 },
      { status: 'GRANTED', lat: 0, lon: 0, accuracyM: 100001 },
      { status: 'GRANTED', lat: Number.NaN, lon: 0, accuracyM: 1 },
      { status: 'GRANTED', lat: 0, lon: 0, accuracyM: Number.POSITIVE_INFINITY },
      { status: 'GRANTED', lat: 0, lon: 0 },
      { status: 'NOT_REQUESTED' },
    ];

    for (const b of bad) {
      expect(ZRevalleGeolocationSchema.safeParse(b).success).toBe(false);
    }
  });
});

describe('roundGeolocation', () => {
  it('arredonda lat/lon a 5 casas e a precisão a inteiro', () => {
    expect(roundGeolocation({ status: 'GRANTED', lat: -12.9714159, lon: -38.5014199, accuracyM: 19.6 })).toEqual({
      status: 'GRANTED',
      lat: -12.97142,
      lon: -38.50142,
      accuracyM: 20,
    });
    expect(roundGeolocation({ status: 'DENIED' })).toEqual({ status: 'DENIED' });
  });
});
