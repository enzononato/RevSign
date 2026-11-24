// REVALLE: texto e botão alinhados à esquerda, como numa carta (e-mails simples, 24/11/2026).
import { Trans } from '@lingui/react/macro';

import { Button, Section, Text } from '../components';
import { TemplateDocumentImage } from './template-document-image';

export type TemplateForgotPasswordProps = {
  resetPasswordLink: string;
  assetBaseUrl: string;
};

export const TemplateForgotPassword = ({ resetPasswordLink, assetBaseUrl }: TemplateForgotPasswordProps) => {
  return (
    <>
      <TemplateDocumentImage className="mt-6" assetBaseUrl={assetBaseUrl} />

      <Section className="flex-row items-center justify-center">
        <Text className="mb-0 text-left font-semibold text-foreground text-lg">
          <Trans>Forgot your password?</Trans>
        </Text>

        <Text className="my-1 text-left text-base text-muted-foreground">
          <Trans>That's okay, it happens! Click the button below to reset your password.</Trans>
        </Text>

        <Section className="mt-8 mb-6 text-left">
          <Button
            className="inline-flex items-center justify-center rounded-lg bg-primary px-6 py-3 text-left font-medium text-primary-foreground text-sm no-underline"
            href={resetPasswordLink}
          >
            <Trans>Reset Password</Trans>
          </Button>
        </Section>
      </Section>
    </>
  );
};

export default TemplateForgotPassword;
