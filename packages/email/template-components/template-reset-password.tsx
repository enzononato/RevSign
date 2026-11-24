// REVALLE: texto e botão alinhados à esquerda, como numa carta (e-mails simples, 24/11/2026).
import { env } from '@documenso/lib/utils/env';
import { Trans } from '@lingui/react/macro';

import { Button, Section, Text } from '../components';
import { TemplateDocumentImage } from './template-document-image';

export interface TemplateResetPasswordProps {
  userName: string;
  userEmail: string;
  assetBaseUrl: string;
}

export const TemplateResetPassword = ({ assetBaseUrl }: TemplateResetPasswordProps) => {
  const NEXT_PUBLIC_WEBAPP_URL = env('NEXT_PUBLIC_WEBAPP_URL');

  return (
    <>
      <TemplateDocumentImage className="mt-6" assetBaseUrl={assetBaseUrl} />

      <Section className="flex-row items-center justify-center">
        <Text className="mb-0 text-left font-semibold text-foreground text-lg">
          <Trans>Password updated!</Trans>
        </Text>

        <Text className="my-1 text-left text-base text-muted-foreground">
          <Trans>Your password has been updated.</Trans>
        </Text>

        <Section className="mt-8 mb-6 text-left">
          <Button
            className="inline-flex items-center justify-center rounded-lg bg-primary px-6 py-3 text-left font-medium text-primary-foreground text-sm no-underline"
            href={`${NEXT_PUBLIC_WEBAPP_URL ?? 'http://localhost:3000'}/signin`}
          >
            <Trans>Sign In</Trans>
          </Button>
        </Section>
      </Section>
    </>
  );
};

export default TemplateResetPassword;
