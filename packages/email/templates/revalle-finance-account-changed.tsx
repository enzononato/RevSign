import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';

import { Body, Button, Container, Head, Hr, Html, Preview, Section, Text } from '../components';
import { TemplateBrandingLogo } from '../template-components/template-branding-logo';
import { TemplateDocumentImage } from '../template-components/template-document-image';
import { TemplateFooter } from '../template-components/template-footer';

// REVALLE: o Financeiro trocou a conta contábil da NF (Fase 6): aviso ao remetente e aos destinatários das duas versões.
export type RevalleFinanceAccountChangedTemplateProps = {
  documentName: string;
  newDocumentName: string;
  /** Texto exato do aviso (`buildAccountChangeNotice`), com as contas e o motivo. */
  notice: string;
  /**
   * O botão desta pessoa: `SIGN` = o link de assinatura dela na nova versão; `VIEW` = a página da NF (o dono, que tem
   * conta no RevSign); `VERIFY` = o /verificar (quem não age na nova versão).
   */
  action: 'SIGN' | 'VIEW' | 'VERIFY';
  actionUrl: string;
  assetBaseUrl: string;
};

export const RevalleFinanceAccountChangedTemplate = ({
  documentName = 'Nota fiscal.pdf',
  newDocumentName = 'Nota fiscal.pdf (v2)',
  notice = 'A conta contábil da nota fiscal Nota fiscal.pdf foi alterada pelo Financeiro de 2.1.03 – Fornecedores para 3.1.01 – Serviços de terceiros. Motivo: Conta de serviço, não de material.',
  action = 'SIGN',
  actionUrl = 'http://localhost:3000/sign/token_exemplo',
  assetBaseUrl = 'http://localhost:3002',
}: Partial<RevalleFinanceAccountChangedTemplateProps>) => {
  const { _ } = useLingui();

  const previewText = msg`Conta contábil da nota fiscal alterada pelo Financeiro: ${documentName}`;

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
                <Trans>A conta contábil de uma nota fiscal foi alterada</Trans>
              </Text>

              <Text className="my-2 text-center text-base text-foreground">{notice}</Text>

              <Text className="my-1 text-center text-base text-muted-foreground">
                <Trans>
                  A versão anterior não vale mais para assinatura. A nova versão, {newDocumentName}, precisa ser
                  assinada de novo por todos.
                </Trans>
              </Text>

              <Section className="mt-6 mb-4 text-center">
                <Button
                  className="inline-flex items-center justify-center rounded-lg bg-primary px-6 py-3 text-center font-medium text-base text-primary-foreground no-underline"
                  href={actionUrl}
                >
                  {action === 'SIGN' && <Trans>Assinar a nova versão</Trans>}
                  {action === 'VIEW' && <Trans>Abrir a nova versão</Trans>}
                  {action === 'VERIFY' && <Trans>Verificar um documento</Trans>}
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

export default RevalleFinanceAccountChangedTemplate;
