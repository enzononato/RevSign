import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';

import { Body, Button, Container, Head, Hr, Html, Preview, Section, Text } from '../components';
import { TemplateBrandingLogo } from '../template-components/template-branding-logo';
import { TemplateDocumentImage } from '../template-components/template-document-image';
import { TemplateFooter } from '../template-components/template-footer';

// REVALLE: "Deixar para o Financeiro" (Fase 6): a NF espera o Financeiro definir a conta; os convites saem depois.
export type RevalleFinanceAwaitingTemplateProps = {
  documentName: string;
  senderName: string;
  senderEmail: string;
  /** Página da NF (só leitura) com o cartão do Financeiro. */
  invoiceUrl: string;
  assetBaseUrl: string;
};

export const RevalleFinanceAwaitingTemplate = ({
  documentName = 'Nota fiscal.pdf',
  senderName = 'Fulano',
  senderEmail = 'fulano@revalle.com.br',
  invoiceUrl = 'http://localhost:3000/notas-fiscais/envelope_exemplo',
  assetBaseUrl = 'http://localhost:3002',
}: Partial<RevalleFinanceAwaitingTemplateProps>) => {
  const { _ } = useLingui();

  const previewText = msg`Nota fiscal aguardando o Financeiro: ${documentName}`;

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
                <Trans>Uma nota fiscal aguarda o Financeiro definir a conta contábil</Trans>
              </Text>

              <Text className="my-1 text-center text-base text-muted-foreground">
                <Trans>Documento: {documentName}</Trans>
              </Text>

              <Text className="my-1 text-center text-base text-muted-foreground">
                <Trans>
                  Enviado por {senderName} ({senderEmail})
                </Trans>
              </Text>

              <Text className="my-1 text-center text-base text-muted-foreground">
                <Trans>
                  O remetente escolheu "Deixar para o Financeiro". Os convites para assinar só saem depois que alguém do
                  Financeiro definir a conta.
                </Trans>
              </Text>

              <Section className="mt-6 mb-4 text-center">
                <Button
                  className="inline-flex items-center justify-center rounded-lg bg-primary px-6 py-3 text-center font-medium text-base text-primary-foreground no-underline"
                  href={invoiceUrl}
                >
                  <Trans>Abrir a nota fiscal</Trans>
                </Button>
              </Section>
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

export default RevalleFinanceAwaitingTemplate;
