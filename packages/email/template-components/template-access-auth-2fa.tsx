// REVALLE: texto e botão alinhados à esquerda, como numa carta (e-mails simples, 24/11/2026).
import { Plural, Trans } from '@lingui/react/macro';

import { Heading, Img, Section, Text } from '../components';
import { getEmailAssetUrl } from '../utils/asset-url';

export type TemplateAccessAuth2FAProps = {
  documentTitle: string;
  code: string;
  userEmail: string;
  userName: string;
  expiresInMinutes: number;
  assetBaseUrl?: string;
};

export const TemplateAccessAuth2FA = ({
  documentTitle,
  code,
  userName,
  expiresInMinutes,
  assetBaseUrl = 'http://localhost:3002',
}: TemplateAccessAuth2FAProps) => {
  return (
    <div>
      <Img src={getEmailAssetUrl(assetBaseUrl, 'static/document.png')} alt="Document" className="h-12 w-12" />

      <Section className="mt-8">
        <Heading className="text-left font-semibold text-foreground text-lg">
          <Trans>Verification Code Required</Trans>
        </Heading>

        <Text className="mt-2 text-left text-foreground">
          <Trans>
            Hi {userName}, you need to enter a verification code to complete the document "{documentTitle}".
          </Trans>
        </Text>

        <Section className="mt-6 rounded-lg bg-muted p-6 text-left">
          <Text className="mb-2 font-medium text-muted-foreground text-sm">
            <Trans>Your verification code:</Trans>
          </Text>
          <Text className="font-bold text-2xl text-foreground tracking-wider">{code}</Text>
        </Section>

        <Text className="mt-4 text-left text-muted-foreground text-sm">
          <Plural
            value={expiresInMinutes}
            one="This code will expire in # minute."
            other="This code will expire in # minutes."
          />
        </Text>

        <Text className="mt-4 text-left text-muted-foreground text-sm">
          <Trans>If you didn't request this verification code, you can safely ignore this email.</Trans>
        </Text>
      </Section>
    </div>
  );
};
