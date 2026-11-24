// REVALLE: texto e botão alinhados à esquerda, como numa carta (e-mails simples, 24/11/2026).
import { Trans } from '@lingui/react/macro';

import { Button, Column, Img, Section, Text } from '../components';
import { getEmailAssetUrl } from '../utils/asset-url';
import { TemplateDocumentImage } from './template-document-image';

export interface TemplateDocumentCompletedProps {
  downloadLink: string;
  documentName: string;
  assetBaseUrl: string;
  customBody?: string;
}

export const TemplateDocumentCompleted = ({
  downloadLink,
  documentName,
  assetBaseUrl,
  customBody,
}: TemplateDocumentCompletedProps) => {
  return (
    <>
      <TemplateDocumentImage className="mt-6" assetBaseUrl={assetBaseUrl} />

      <Section>
        <Section className="mb-4">
          <Column align="left">
            <Text className="font-semibold text-base text-foreground">
              <Img
                src={getEmailAssetUrl(assetBaseUrl, 'static/completed.png')}
                className="-mt-0.5 mr-2 inline h-7 w-7 align-middle"
                alt=""
              />
              <Trans>Completed</Trans>
            </Text>
          </Column>
        </Section>

        <Text className="mb-0 text-left font-semibold text-foreground text-lg">
          {customBody || <Trans>“{documentName}” was signed by all signers</Trans>}
        </Text>

        <Text className="my-1 text-left text-base text-muted-foreground">
          <Trans>Continue by downloading the document.</Trans>
        </Text>

        <Section className="mt-8 mb-6 text-left">
          <Button
            className="rounded-lg border border-border border-solid px-4 py-2 text-left font-medium text-foreground text-sm no-underline"
            href={downloadLink}
          >
            <Img
              src={getEmailAssetUrl(assetBaseUrl, 'static/download.png')}
              className="mr-2 mb-0.5 inline h-5 w-5 align-middle"
              alt=""
            />
            <Trans>Download</Trans>
          </Button>
        </Section>
      </Section>
    </>
  );
};

export default TemplateDocumentCompleted;
