// REVALLE: texto e botão alinhados à esquerda, como numa carta (e-mails simples, 24/11/2026).
import { Trans } from '@lingui/react/macro';

import { Link, Section, Text } from '../components';
import { TemplateDocumentImage } from './template-document-image';

export type TemplateAccountDisabledProps = {
  assetBaseUrl: string;
  supportEmail: string;
};

export const TemplateAccountDisabled = ({ assetBaseUrl, supportEmail }: TemplateAccountDisabledProps) => {
  return (
    <>
      <TemplateDocumentImage className="mt-6" assetBaseUrl={assetBaseUrl} />

      <Section className="flex-row items-center justify-center">
        <Text className="mb-0 text-left font-semibold text-foreground text-lg">
          <Trans>Your account has been disabled</Trans>
        </Text>

        <Text className="mt-2 mb-0 text-left text-base text-muted-foreground">
          <Trans>
            One of your signing requests has been reported. As part of keeping signers safe, we've disabled your account
            for now.
          </Trans>
        </Text>

        <Text className="mt-2 mb-0 text-left text-base text-muted-foreground">
          <Trans>You won't be able to sign in or send documents while it is disabled.</Trans>
        </Text>

        <Text className="mt-4 mb-2 text-left text-base text-muted-foreground">
          <Trans>
            If you believe this was a mistake, contact us at{' '}
            <Link href={`mailto:${supportEmail}`} className="text-primary">
              {supportEmail}
            </Link>
            .
          </Trans>
        </Text>
      </Section>
    </>
  );
};
