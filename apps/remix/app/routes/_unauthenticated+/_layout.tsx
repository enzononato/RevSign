// REVALLE: redesign v3. Telas de acesso: painel azul à esquerda (desktop) ou faixa azul no topo (celular) e o formulário num cartão.
import { Outlet, useLocation } from 'react-router';

import { BrandBand, hairlineGridStyle } from '~/components/general/background';
import { PublicLegalLinks } from '~/components/general/public-legal-links';
import { RevsignWordmark } from '~/components/revalle/shell/revsign-wordmark';
import { SourceCodeLink } from '~/components/revalle/source-code-link';

// Telas que já trazem o próprio cartão ou são texto corrido: ficam largas, sem o cartão do formulário.
const WIDE_ROUTES = ['/articles/', '/organisation/sso/'];

export default function Layout() {
  const { pathname } = useLocation();
  const isWide = WIDE_ROUTES.some((prefix) => pathname.startsWith(prefix));

  return (
    <main className="min-h-[calc(100vh-3rem)] bg-background lg:flex lg:min-h-screen">
      <aside
        className="fixed inset-y-0 left-0 hidden w-[44%] flex-col justify-between bg-shell p-14 text-shell-foreground lg:flex xl:p-16"
        style={hairlineGridStyle}
      >
        <RevsignWordmark variant="onBrand" size="xl" withTagline />

        <div className="flex flex-col gap-6">
          <p className="max-w-md font-semibold text-[20px] text-white leading-snug">
            Assinaturas e notas fiscais da Revalle, com prova de quem assinou.
          </p>

          {/* REVALLE: link AGPL no painel azul; o rodapé do root se esconde aqui no computador. */}
          <SourceCodeLink variant="shell" className="-mx-2.5 text-[12.5px]" />
        </div>
      </aside>

      <div className="flex flex-1 flex-col lg:ml-[44%]">
        <BrandBand className="lg:hidden">
          <RevsignWordmark variant="onBrand" size="lg" withTagline />
        </BrandBand>

        <div className="flex flex-1 flex-col items-center justify-center px-4 py-8 lg:px-12 lg:py-16">
          {isWide ? (
            <div className="w-full max-w-3xl">
              <Outlet />
            </div>
          ) : (
            <div className="w-full max-w-[440px] rounded-[24px] bg-card p-6 shadow-card sm:p-8">
              <Outlet />
            </div>
          )}

          <PublicLegalLinks className="mt-8" />
        </div>
      </div>
    </main>
  );
}
