// REVALLE: texto e botão alinhados à esquerda, como numa carta (e-mails simples, 24/11/2026).
import { SUPPORT_EMAIL } from '@documenso/lib/constants/app';
import { Trans } from '@lingui/react/macro';

import { Button, Link, Section, Text } from '../components';
import { TemplateDocumentImage } from './template-document-image';

export type TemplateAdminUserCreatedProps = {
  resetPasswordLink: string;
  assetBaseUrl: string;
};

export const TemplateAdminUserCreated = ({ resetPasswordLink, assetBaseUrl }: TemplateAdminUserCreatedProps) => {
  return (
    <>
      <TemplateDocumentImage className="mt-6" assetBaseUrl={assetBaseUrl} />

      <Section className="flex-row items-center justify-center">
        <Text className="mb-0 text-left font-semibold text-foreground text-lg">
          <Trans>Welcome to Documenso!</Trans>
        </Text>

        <Text className="my-1 text-left text-base text-muted-foreground">
          <Trans>An administrator has created a Documenso account for you.</Trans>
        </Text>

        <Text className="my-1 text-left text-base text-muted-foreground">
          <Trans>To get started, please set your password by clicking the button below:</Trans>
        </Text>

        <Section className="mt-8 mb-6 text-left">
          <Button
            className="inline-flex items-center justify-center rounded-lg bg-primary px-6 py-3 text-left font-medium text-primary-foreground text-sm no-underline"
            href={resetPasswordLink}
          >
            <Trans>Set Password</Trans>
          </Button>
          <Text className="mt-8 text-left text-muted-foreground text-sm italic">
            <Trans>
              You can also copy and paste this link into your browser: {resetPasswordLink} (link expires in 24 hours)
            </Trans>
          </Text>
        </Section>

        <Section className="mt-8">
          <Text className="text-left text-muted-foreground text-sm">
            {/* REVALLE: suporte da TI da Revalle (NEXT_PUBLIC_SUPPORT_EMAIL) */}
            <Trans>
              If you didn't expect this account or have any questions, please{' '}
              <Link href={`mailto:${SUPPORT_EMAIL}`} className="text-primary">
                contact support
              </Link>
              .
            </Trans>
          </Text>
        </Section>
      </Section>
    </>
  );
};
