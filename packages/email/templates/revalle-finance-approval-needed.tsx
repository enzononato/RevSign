import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';

import { Body, Button, Container, Head, Hr, Html, Preview, Section, Text } from '../components';
import { TemplateBrandingLogo } from '../template-components/template-branding-logo';
import { TemplateDocumentImage } from '../template-components/template-document-image';
import { TemplateFooter } from '../template-components/template-footer';

// REVALLE: selagem retida (Fase 6): todos assinaram a NF e ela só é concluída depois que o Financeiro aprovar a conta.
export type RevalleFinanceApprovalNeededTemplateProps = {
  documentName: string;
  senderName: string;
  senderEmail: string;
  account: string;
  /** Página da NF (só leitura) com o cartão do Financeiro. */
  invoiceUrl: string;
  assetBaseUrl: string;
};

export const RevalleFinanceApprovalNeededTemplate = ({
  documentName = 'Nota fiscal.pdf',
  senderName = 'Fulano',
  senderEmail = 'fulano@revalle.com.br',
  account = '2.1.03 – Fornecedores',
  invoiceUrl = 'http://localhost:3000/notas-fiscais/envelope_exemplo',
  assetBaseUrl = 'http://localhost:3002',
}: Partial<RevalleFinanceApprovalNeededTemplateProps>) => {
  const { _ } = useLingui();

  const previewText = msg`Nota fiscal aguardando aprovação do Financeiro: ${documentName}`;

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
                <Trans>Uma nota fiscal aguarda a aprovação do Financeiro</Trans>
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
                <Trans>Conta contábil: {account}</Trans>
              </Text>

              <Text className="my-1 text-center text-base text-muted-foreground">
                <Trans>
                  Todos já assinaram. O documento só é concluído (e enviado à contabilidade) depois que alguém do
                  Financeiro aprovar a conta.
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

export default RevalleFinanceApprovalNeededTemplate;
