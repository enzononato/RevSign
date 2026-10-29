import { DateTime } from 'luxon';

// REVALLE: datas sempre em dd/MM/yyyy HH:mm no fuso de Brasília (America/Bahia, sem horário de verão),
// independente do TZ do processo.
export const REVALLE_TIME_ZONE = 'America/Bahia';

export const formatRevalleDateTime = (date: Date | string, options: { withZoneLabel?: boolean } = {}): string => {
  const parsed = typeof date === 'string' ? DateTime.fromISO(date) : DateTime.fromJSDate(date);
  const formatted = parsed.setZone(REVALLE_TIME_ZONE).toFormat('dd/MM/yyyy HH:mm');

  return options.withZoneLabel ? `${formatted} (horário de Brasília)` : formatted;
};
