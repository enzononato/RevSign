import type { I18n, Messages } from '@lingui/core';
import { setupI18n } from '@lingui/core';

import { isValidLanguageCode, SUPPORTED_LANGUAGE_CODES } from '../../constants/i18n';
import { REVALLE_DEFAULT_LOCALE } from '../../revalle/locale';
import { env } from '../../utils/env';
import { remember } from '../../utils/remember';

type SupportedLanguages = (typeof SUPPORTED_LANGUAGE_CODES)[number];

export async function loadCatalog(lang: SupportedLanguages): Promise<{
  [k: string]: Messages;
}> {
  const extension = env('NODE_ENV') === 'development' ? 'po' : 'mjs';

  const { messages } = await import(`../../translations/${lang}/web.${extension}`);

  return {
    [lang]: messages,
  };
}

const catalogs = Promise.all(SUPPORTED_LANGUAGE_CODES.map(loadCatalog));

// transform array of catalogs into a single object
const allMessages = async () => {
  return await catalogs.then((catalogs) =>
    catalogs.reduce((acc, oneCatalog) => {
      return {
        ...acc,
        ...oneCatalog,
      };
    }, {}),
  );
};

type AllI18nInstances = { [K in SupportedLanguages]: I18n };

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
export const allI18nInstances = remember('i18n.allI18nInstances', async () => {
  const loadedMessages = await allMessages();

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return SUPPORTED_LANGUAGE_CODES.reduce((acc, lang) => {
    const messages = loadedMessages[lang] ?? {};

    const i18n = setupI18n({
      locale: lang,
      messages: { [lang]: messages },
    });

    return { ...acc, [lang]: i18n };
  }, {}) as AllI18nInstances;
});

// eslint-disable-next-line @typescript-eslint/ban-types
export const getI18nInstance = async (lang?: SupportedLanguages | (string & {})) => {
  const instances = await allI18nInstances;

  // REVALLE: sem idioma explícito (e-mails de conta), pt-BR; idioma explícito válido é respeitado.
  if (!isValidLanguageCode(lang)) {
    return instances[REVALLE_DEFAULT_LOCALE];
  }

  return instances[lang] ?? instances[REVALLE_DEFAULT_LOCALE];
};
