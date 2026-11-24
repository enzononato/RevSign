// REVALLE: texto e botão alinhados à esquerda, como numa carta (e-mails simples, 24/11/2026).
import { Trans } from '@lingui/react/macro';

import { Button, Section, Text } from '../components';
import { TemplateDocumentImage } from './template-document-image';

export type TemplateRecipientExpiredProps = {
  documentName: string;
  recipientName: string;
  recipientEmail: string;
  documentLink: string;
  assetBaseUrl: string;
};

export const TemplateRecipientExpired = ({
  documentName,
  recipientName,
  recipientEmail,
  documentLink,
  assetBaseUrl,
}: TemplateRecipientExpiredProps) => {
  const displayName = recipientName || recipientEmail;

  return (
    <>
      <TemplateDocumentImage className="mt-6" assetBaseUrl={assetBaseUrl} />

      <Section>
        <Text className="mb-0 text-left font-semibold text-foreground text-lg">
          <Trans>
            Signing window expired for "{displayName}" on "{documentName}"
          </Trans>
        </Text>

        <Text className="my-1 text-left text-base text-muted-foreground">
          <Trans>
            The signing window for {displayName} on document "{documentName}" has expired. You can resend the document
            to extend their deadline or cancel the document.
          </Trans>
        </Text>

        <Section className="my-4 text-left">
          <Button
            className="inline-flex items-center justify-center rounded-lg bg-primary px-6 py-3 text-left font-medium text-primary-foreground text-sm no-underline"
            href={documentLink}
          >
            <Trans>View Document</Trans>
          </Button>
        </Section>
      </Section>
    </>
  );
};

export default TemplateRecipientExpired;
