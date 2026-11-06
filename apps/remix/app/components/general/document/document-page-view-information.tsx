import { useIsMounted } from '@documenso/lib/client-only/hooks/use-is-mounted';
import type { TEnvelope } from '@documenso/lib/types/envelope';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { DateTime } from 'luxon';
import { useMemo } from 'react';

export type DocumentPageViewInformationProps = {
  userId: number;
  envelope: TEnvelope;
};

export const DocumentPageViewInformation = ({ envelope, userId }: DocumentPageViewInformationProps) => {
  const isMounted = useIsMounted();

  const { _, i18n } = useLingui();

  const documentInformation = useMemo(() => {
    return [
      {
        description: msg`Uploaded by`,
        value: userId === envelope.userId ? _(msg`You`) : (envelope.user.name ?? envelope.user.email),
      },
      {
        description: msg`Created`,
        value: DateTime.fromJSDate(envelope.createdAt)
          .setLocale(i18n.locales?.[0] || i18n.locale)
          .toFormat('MMMM d, yyyy'),
      },
      {
        description: msg`Last modified`,
        value: DateTime.fromJSDate(envelope.updatedAt)
          .setLocale(i18n.locales?.[0] || i18n.locale)
          .toRelative(),
      },
      {
        description: msg`Document ID (Legacy)`,
        value: mapSecondaryIdToDocumentId(envelope.secondaryId),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMounted, envelope, userId]);

  return (
    // REVALLE v3: cartão macio, rótulo à esquerda e valor à direita
    <section className="flex flex-col rounded-card bg-card text-foreground shadow-card dark:shadow-[0_0_0_1px_hsl(var(--border))]">
      <h2 className="px-5 pt-4 pb-2 font-display font-extrabold text-[17px]">
        <Trans>Information</Trans>
      </h2>

      <ul className="divide-y px-5 pb-2">
        {documentInformation.map((item, i) => (
          <li key={i} className="flex items-baseline justify-between gap-4 py-2.5 text-sm">
            <span className="shrink-0 text-muted-foreground">{_(item.description)}</span>
            <span className="min-w-0 break-words text-right font-semibold">{item.value}</span>
          </li>
        ))}
      </ul>
    </section>
  );
};
