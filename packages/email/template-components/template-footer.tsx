import { REVALLE_COMPANY_FOOTER } from '@documenso/lib/revalle/brand';
import { Fragment } from 'react';

import { Link, Section, Text } from '../components';
import { useBranding } from '../providers/branding';
import { getSafeBrandingUrl } from '../utils/branding-url';

export type TemplateFooterProps = {
  isDocument?: boolean;
  reportUrl?: string;
};

export const TemplateFooter = (_props: TemplateFooterProps) => {
  const branding = useBranding();

  const safeBrandingUrl = branding.brandingEnabled ? getSafeBrandingUrl(branding.brandingUrl) : null;

  return (
    <Section>
      {/* REVALLE: sem o "Não esperava este e-mail? Denunciar o remetente": todo envio sai de dentro da Revalle. */}

      {/* REVALLE: sem o "enviado usando Documenso" (link de divulgação para documen.so) */}

      {branding.brandingEnabled && branding.brandingCompanyDetails && (
        <Text className="my-8 text-muted-foreground text-sm">
          {branding.brandingCompanyDetails.split('\n').map((line, idx) => {
            return (
              <Fragment key={idx}>
                {idx > 0 && <br />}
                {line}
              </Fragment>
            );
          })}
        </Text>
      )}

      {branding.brandingEnabled && safeBrandingUrl && (
        <Text className="my-8 text-muted-foreground text-sm">
          <Link href={safeBrandingUrl} target="_blank">
            {safeBrandingUrl}
          </Link>
        </Text>
      )}

      {!branding.brandingEnabled && (
        <Text className="my-8 text-muted-foreground text-sm">
          {/* REVALLE: rodapé da Revalle no lugar do endereço do Documenso */}
          {REVALLE_COMPANY_FOOTER}
        </Text>
      )}
    </Section>
  );
};

export default TemplateFooter;
