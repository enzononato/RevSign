import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { REVALLE_APP_NAME, REVALLE_COMPANY_FOOTER } from '@documenso/lib/revalle/brand';
import { i18n, type MessageDescriptor } from '@lingui/core';

// REVALLE: título "<Página> · RevSign" e descrição da Revalle; sem keywords, autor e twitter do Documenso.
export const revalleTitle = (page?: string) => (page ? `${page} · ${REVALLE_APP_NAME}` : REVALLE_APP_NAME);

export const appMetaTags = (title?: MessageDescriptor) => {
  const description = REVALLE_COMPANY_FOOTER;

  return [
    {
      title: revalleTitle(title ? i18n._(title) : undefined),
    },
    {
      name: 'description',
      content: description,
    },
    {
      name: 'robots',
      content: 'noindex, nofollow',
    },
    {
      property: 'og:title',
      content: REVALLE_APP_NAME,
    },
    {
      property: 'og:description',
      content: description,
    },
    {
      property: 'og:image',
      content: `${NEXT_PUBLIC_WEBAPP_URL()}/opengraph-image.jpg`,
    },
    {
      property: 'og:type',
      content: 'website',
    },
  ];
};
