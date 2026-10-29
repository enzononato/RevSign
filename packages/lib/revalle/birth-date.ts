import { DateTime } from 'luxon';

const BIRTH_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const EARLIEST_BIRTH_YEAR = 1900;
const TIME_ZONE = 'America/Bahia';

export const parseBirthDateInput = (input: string): string | null => {
  const match = BIRTH_DATE_PATTERN.exec(input.trim());

  if (!match) {
    return null;
  }

  const [, day, month, year] = match;
  const birthDate = DateTime.fromObject({ year: Number(year), month: Number(month), day: Number(day) });

  if (!birthDate.isValid || birthDate.year < EARLIEST_BIRTH_YEAR) {
    return null;
  }

  const isoDate = birthDate.toISODate();
  const today = DateTime.now().setZone(TIME_ZONE).toISODate();

  if (!isoDate || !today || isoDate > today) {
    return null;
  }

  return isoDate;
};
