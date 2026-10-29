import { type RevalleGeolocation, roundGeolocation } from '@documenso/lib/revalle/geolocation';
import { useCallback, useRef } from 'react';

// REVALLE: localização opcional do aparelho (Fase 4, spec 7.3). Nunca lança; recusa ou falha não bloqueiam a assinatura.
const LOCATION_TIMEOUT_MS = 10_000;
const LOCATION_MAX_AGE_MS = 60_000;

const getLocation = (): Promise<RevalleGeolocation> =>
  new Promise((resolve) => {
    // Guarda extra caso o navegador nunca chame nenhum dos callbacks.
    const guard = setTimeout(() => resolve({ status: 'UNAVAILABLE' }), LOCATION_TIMEOUT_MS + 2000);
    const done = (value: RevalleGeolocation) => {
      clearTimeout(guard);
      resolve(value);
    };

    try {
      if (typeof navigator === 'undefined' || !navigator.geolocation || !window.isSecureContext) {
        done({ status: 'UNAVAILABLE' });
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude, accuracy } = position.coords;

          if (![latitude, longitude, accuracy].every(Number.isFinite)) {
            done({ status: 'UNAVAILABLE' });
            return;
          }

          done(roundGeolocation({ status: 'GRANTED', lat: latitude, lon: longitude, accuracyM: accuracy }));
        },
        (error) => done({ status: error.code === error.PERMISSION_DENIED ? 'DENIED' : 'UNAVAILABLE' }),
        { enableHighAccuracy: true, timeout: LOCATION_TIMEOUT_MS, maximumAge: LOCATION_MAX_AGE_MS },
      );
    } catch {
      done({ status: 'UNAVAILABLE' });
    }
  });

export const useDeviceLocation = () => {
  const inFlight = useRef<Promise<RevalleGeolocation> | null>(null);

  // Cliques repetidos compartilham a mesma consulta (um só pedido ao navegador).
  const request = useCallback((): Promise<RevalleGeolocation> => {
    if (!inFlight.current) {
      inFlight.current = getLocation().finally(() => {
        inFlight.current = null;
      });
    }

    return inFlight.current;
  }, []);

  return { request };
};
