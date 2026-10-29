import { useIsFramed } from '@documenso/lib/client-only/hooks/use-is-framed';
import {
  canRequestDeviceLocation,
  type RevalleGeolocation,
  revalleRoleRequestsDeviceLocation,
  roundGeolocation,
} from '@documenso/lib/revalle/geolocation';
import type { RecipientRole } from '@prisma/client';
import { useCallback, useRef, useState } from 'react';
import { useEmbedSigningContext } from '~/components/embed/embed-signing-context';

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

/** false em embed/iframe e para VIEWER/CC (sem portão nem termo): o aviso some e nada é pedido. */
export const useCanRequestDeviceLocation = (role: RecipientRole) => {
  const isFramed = useIsFramed();
  const embed = useEmbedSigningContext();

  return (
    revalleRoleRequestsDeviceLocation(role) && canRequestDeviceLocation({ hasEmbedContext: Boolean(embed), isFramed })
  );
};

/**
 * `request()` devolve a localização a enviar na conclusão. VIEWER/CC: `undefined` (o servidor grava NOT_REQUESTED);
 * embed/iframe: `UNAVAILABLE`, sem perguntar ao navegador.
 */
export const useDeviceLocation = (role: RecipientRole) => {
  const inFlight = useRef<Promise<RevalleGeolocation> | null>(null);
  const [isLocating, setIsLocating] = useState(false);
  const roleAsks = revalleRoleRequestsDeviceLocation(role);
  const canRequest = useCanRequestDeviceLocation(role);

  // Cliques repetidos compartilham a mesma consulta (um só pedido ao navegador).
  const request = useCallback((): Promise<RevalleGeolocation | undefined> => {
    if (!roleAsks) {
      return Promise.resolve(undefined);
    }

    if (!canRequest) {
      return Promise.resolve({ status: 'UNAVAILABLE' });
    }

    if (!inFlight.current) {
      setIsLocating(true);
      inFlight.current = getLocation().finally(() => {
        inFlight.current = null;
        setIsLocating(false);
      });
    }

    return inFlight.current;
  }, [roleAsks, canRequest]);

  return { request, isLocating };
};
