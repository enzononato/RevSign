import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';

import { Body, Container, Head, Hr, Html, Preview, Section, Text } from '../components';
import { TemplateBrandingLogo } from '../template-components/template-branding-logo';
import { TemplateDocumentImage } from '../template-components/template-document-image';
import { TemplateFooter } from '../template-components/template-footer';

// REVALLE: e-mail para a contabilidade quando uma nota fiscal é concluída (Fase 5).
export type RevalleInvoiceAccountingTemplateProps = {
  documentName: string;
  senderName: string;
  senderEmail: string;
  /** Já formatada em horário de Brasília, com "(horário de Brasília)". */
  completedAt: string;
  /** "2.1.03 – Fornecedores", ou null quando ficou para o Financeiro (NF de antes da Fase 6). */
  account: string | null;
  origin: 'SUGGESTION_ACCEPTED' | 'CHOSEN' | null;
  assetBaseUrl: string;
};

export const RevalleInvoiceAccountingTemplate = ({
  documentName = 'Nota fiscal.pdf',
  senderName = 'Fulano',
  senderEmail = 'fulano@revalle.com.br',
  completedAt = '30/10/2026 10:00 (horário de Brasília)',
  account = '2.1.03 – Fornecedores',
  origin = 'CHOSEN',
  assetBaseUrl = 'http://localhost:3002',
}: Partial<RevalleInvoiceAccountingTemplateProps>) => {
  const { _ } = useLingui();

  const previewText = msg`Nota fiscal assinada: ${documentName}`;

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
                <Trans>Uma nota fiscal foi assinada</Trans>
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
                <Trans>Concluído em {completedAt}</Trans>
              </Text>

              <Text className="my-1 text-center text-base text-foreground">
                {account ? <Trans>Conta contábil: {account}</Trans> : <Trans>Conta: a definir pelo Financeiro</Trans>}
              </Text>

              {origin === 'SUGGESTION_ACCEPTED' && (
                <Text className="my-1 text-center text-base text-muted-foreground">
                  <Trans>A conta foi sugerida pela IA e aceita pelo remetente.</Trans>
                </Text>
              )}

              {origin === 'CHOSEN' && (
                <Text className="my-1 text-center text-base text-muted-foreground">
                  <Trans>A conta foi escolhida pelo remetente.</Trans>
                </Text>
              )}

              <Text className="my-1 text-center text-base text-muted-foreground">
                <Trans>O PDF assinado está em anexo.</Trans>
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

export default RevalleInvoiceAccountingTemplate;
