import { z } from 'zod';

// REVALLE: localização opcional do aparelho na conclusão (Fase 4, spec 7.3). Compartilhado cliente/servidor.
export const ZRevalleGeolocationSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('GRANTED'),
    lat: z.number().finite().min(-90).max(90),
    lon: z.number().finite().min(-180).max(180),
    accuracyM: z.number().finite().min(0).max(100000),
  }),
  z.object({ status: z.literal('DENIED') }),
  z.object({ status: z.literal('UNAVAILABLE') }),
]);

export type RevalleGeolocation = z.infer<typeof ZRevalleGeolocationSchema>;

/** Arredonda para ~1 m (5 casas) e metros inteiros; o que o servidor grava. */
export const roundGeolocation = (geo: RevalleGeolocation): RevalleGeolocation =>
  geo.status === 'GRANTED'
    ? {
        status: 'GRANTED',
        lat: Math.round(geo.lat * 1e5) / 1e5,
        lon: Math.round(geo.lon * 1e5) / 1e5,
        accuracyM: Math.round(geo.accuracyM),
      }
    : geo;
