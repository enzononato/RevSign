import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';

import { Body, Container, Head, Hr, Html, Preview, Section, Text } from '../components';
import { TemplateBrandingLogo } from '../template-components/template-branding-logo';
import { TemplateDocumentImage } from '../template-components/template-document-image';
import { TemplateFooter } from '../template-components/template-footer';

export type RevalleGateLockedTemplateProps = {
  documentName: string;
  recipientEmail: string;
  reason: 'ATTEMPTS' | 'CPF_CONFLICT';
  assetBaseUrl: string;
};

export const RevalleGateLockedTemplate = ({
  documentName = 'Contrato.pdf',
  recipientEmail = 'fulano@revalle.com.br',
  reason = 'ATTEMPTS',
  assetBaseUrl = 'http://localhost:3002',
}: Partial<RevalleGateLockedTemplateProps>) => {
  const { _ } = useLingui();

  const previewText = msg`Link de assinatura bloqueado — ${documentName}`;

  return (
    <Html>
      <Head />

      <Body className="mx-auto my-auto bg-background font-sans">
        <Preview>{_(previewText)}</Preview>

        <Section>
          <Container className="mx-auto mt-8 mb-2 max-w-xl rounded-lg border border-border border-solid p-4 backdrop-blur-sm">
            <Section>
              <TemplateBrandingLogo assetBaseUrl={assetBaseUrl} className="mb-4 h-6" />

              <TemplateDocumentImage className="mt-6" assetBaseUrl={assetBaseUrl} />

              <Text className="mx-auto mb-0 max-w-[80%] text-center font-semibold text-foreground text-lg">
                <Trans>O link de assinatura foi bloqueado</Trans>
              </Text>

              <Text className="my-1 text-center text-base text-muted-foreground">
                <Trans>
                  O link de {recipientEmail} para o documento "{documentName}" foi bloqueado.
                </Trans>
              </Text>

              <Text className="my-1 text-center text-base text-muted-foreground">
                {reason === 'ATTEMPTS' ? (
                  <Trans>Motivo: a pessoa errou o CPF ou a data de nascimento 5 vezes.</Trans>
                ) : (
                  <Trans>Motivo: o CPF informado já pertence a outro e-mail.</Trans>
                )}
              </Text>

              <Text className="my-1 text-center text-base text-muted-foreground">
                <Trans>Para liberar, peça ao TI para desbloquear em Admin → Verificações.</Trans>
              </Text>
            </Section>
          </Container>

          <Hr className="mx-auto mt-12 max-w-xl" />

          <Container className="mx-auto max-w-xl">
            <TemplateFooter />
          </Container>
        </Section>
      </Body>
    </Html>
  );
};

export default RevalleGateLockedTemplate;
