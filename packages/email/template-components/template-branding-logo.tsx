import { RevalleWordmark } from './revalle-letter';

export type TemplateBrandingLogoProps = {
  assetBaseUrl: string;
  className?: string;
};

/**
 * REVALLE: e-mails sem imagem (24/11/2026): no lugar do logo (o do RevSign ou o da marca personalizada), sempre a marca
 * em texto "RevSign · Revalle". A Revalle não usa logo personalizado e imagem pesa para o Gmail mandar para
 * "Promoções". `assetBaseUrl` e `className` ficam no tipo para os modelos do upstream continuarem iguais.
 */
export const TemplateBrandingLogo = (_props: TemplateBrandingLogoProps) => {
  return (
    <div style={{ marginBottom: '16px' }}>
      <RevalleWordmark />
    </div>
  );
};

export default TemplateBrandingLogo;
