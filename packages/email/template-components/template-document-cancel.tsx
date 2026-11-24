// REVALLE: texto e botão alinhados à esquerda, como numa carta (e-mails simples, 24/11/2026).
import { Trans } from '@lingui/react/macro';

import { Section, Text } from '../components';
import { TemplateDocumentImage } from './template-document-image';

export interface TemplateDocumentCancelProps {
  inviterName: string;
  inviterEmail: string;
  documentName: string;
  assetBaseUrl: string;
  cancellationReason?: string;
}

export const TemplateDocumentCancel = ({
  inviterName,
  documentName,
  assetBaseUrl,
  cancellationReason,
}: TemplateDocumentCancelProps) => {
  return (
    <>
      <TemplateDocumentImage className="mt-6" assetBaseUrl={assetBaseUrl} />

      <Section>
        <Text className="mb-0 text-left font-semibold text-foreground text-lg">
          <Trans>
            {inviterName} has cancelled the document
            <br />"{documentName}"
          </Trans>
        </Text>

        <Text className="my-1 text-left text-base text-muted-foreground">
          <Trans>All signatures have been voided.</Trans>
        </Text>

        <Text className="my-1 text-left text-base text-muted-foreground">
          <Trans>You don't need to sign it anymore.</Trans>
        </Text>

        {cancellationReason && (
          <Text className="mt-4 text-left text-base">
            <Trans>Reason for cancellation: {cancellationReason}</Trans>
          </Text>
        )}
      </Section>
    </>
  );
};

export default TemplateDocumentCancel;
