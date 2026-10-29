import { UAParser } from 'ua-parser-js';

export const UNKNOWN_DEVICE = 'Dispositivo não identificado';

const major = (version?: string) => version?.split('.')[0] ?? '';

/** "Android 14 · Chrome 130". Sempre devolve um texto legível. */
export const describeUserAgent = (ua: string | null | undefined): string => {
  if (!ua || !ua.trim()) {
    return UNKNOWN_DEVICE;
  }

  try {
    const { os, browser } = new UAParser(ua).getResult();
    const osLabel = [os.name, os.version].filter(Boolean).join(' ').trim();
    const browserLabel = [browser.name, major(browser.version)].filter(Boolean).join(' ').trim();
    const parts = [osLabel, browserLabel].filter(Boolean);

    return parts.length > 0 ? parts.join(' · ') : UNKNOWN_DEVICE;
  } catch {
    return UNKNOWN_DEVICE;
  }
};
