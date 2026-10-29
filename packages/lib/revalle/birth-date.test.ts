import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';

import { parseBirthDateInput } from './birth-date';

describe('parseBirthDateInput', () => {
  it('converts a dd/MM/yyyy date to yyyy-MM-dd', () => {
    expect(parseBirthDateInput('07/03/1990')).toBe('1990-03-07');
  });

  it('accepts single-digit day and month', () => {
    expect(parseBirthDateInput('7/3/1990')).toBe('1990-03-07');
  });

  it('ignores surrounding spaces', () => {
    expect(parseBirthDateInput('  07/03/1990 ')).toBe('1990-03-07');
  });

  it('accepts 29/02 only in leap years, including the first day of 1900', () => {
    expect(parseBirthDateInput('29/02/2000')).toBe('2000-02-29');
    expect(parseBirthDateInput('29/02/1900')).toBeNull();
    expect(parseBirthDateInput('29/02/2001')).toBeNull();
    expect(parseBirthDateInput('01/01/1900')).toBe('1900-01-01');
  });

  it('rejects a date that does not exist', () => {
    expect(parseBirthDateInput('31/02/1990')).toBeNull();
  });

  it('rejects a date in another format', () => {
    expect(parseBirthDateInput('1990-03-07')).toBeNull();
  });

  it('rejects a year before 1900', () => {
    expect(parseBirthDateInput('01/01/1899')).toBeNull();
  });

  it('rejects a date after today in America/Bahia and accepts today', () => {
    const today = DateTime.now().setZone('America/Bahia');
    const tomorrow = today.plus({ days: 1 });

    expect(parseBirthDateInput(today.toFormat('dd/MM/yyyy'))).toBe(today.toISODate());
    expect(parseBirthDateInput(tomorrow.toFormat('dd/MM/yyyy'))).toBeNull();
  });
});
