import { Button } from '@documenso/ui/primitives/button';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { ChevronLeft } from 'lucide-react';
import { Link, useNavigate } from 'react-router';

import { BrandBand } from '~/components/general/background';
import { RevsignWordmark } from '~/components/revalle/shell/revsign-wordmark';

type ErrorCodeMap = Record<
  number,
  { subHeading: MessageDescriptor; heading: MessageDescriptor; message: MessageDescriptor }
>;

export type GenericErrorLayoutProps = {
  children?: React.ReactNode;
  errorCode?: number;
  errorCodeMap?: ErrorCodeMap;
  /**
   * The primary button to display. If left as undefined, the default home link will be displayed.
   *
   * Set to null if you want no button.
   */
  primaryButton?: React.ReactNode | null;

  /**
   * The secondary button to display. If left as undefined, the default back button will be displayed.
   *
   * Set to null if you want no button.
   */
  secondaryButton?: React.ReactNode | null;
};

export const defaultErrorCodeMap: ErrorCodeMap = {
  404: {
    subHeading: msg`404 not found`,
    heading: msg`Oops! Something went wrong.`,
    message: msg`The page you are looking for was moved, removed, renamed or might never have existed.`,
  },
  500: {
    subHeading: msg`500 Internal Server Error`,
    heading: msg`Oops! Something went wrong.`,
    message: msg`An unexpected error occurred.`,
  },
};

export const GenericErrorLayout = ({
  children,
  errorCode,
  errorCodeMap = defaultErrorCodeMap,
  primaryButton,
  secondaryButton,
}: GenericErrorLayoutProps) => {
  const navigate = useNavigate();
  const { _ } = useLingui();

  const { subHeading, heading, message } = errorCodeMap[errorCode || 500] ?? defaultErrorCodeMap[500];

  // REVALLE: redesign v3. Faixa azul + um cartão com código, mensagem e botões (sem o padrão de fundo do Documenso).
  return (
    <div className="fixed inset-0 z-0 flex flex-col overflow-auto bg-background">
      <BrandBand className="flex-none">
        <div className="mx-auto w-full max-w-[440px]">
          <RevsignWordmark variant="onBrand" size="lg" withTagline />
        </div>
      </BrandBand>

      <div className="-mt-8 flex flex-1 items-start justify-center px-4 pb-12">
        <div className="w-full max-w-[440px] rounded-[24px] bg-card p-6 shadow-card sm:p-8">
          <p className="font-black font-display text-[28px] text-brand-text leading-tight tracking-[-0.035em]">
            {_(subHeading)}
          </p>

          <h1 className="mt-4 text-[24px] leading-tight">{_(heading)}</h1>

          <p className="mt-3 text-muted-foreground text-sm">{_(message)}</p>

          <div className="mt-6 flex flex-wrap gap-x-2.5 gap-y-3 md:items-center">
            {primaryButton ||
              (primaryButton !== null && (
                <Button asChild>
                  <Link to={'/'}>
                    <Trans>Home</Trans>
                  </Link>
                </Button>
              ))}

            {secondaryButton ||
              (secondaryButton !== null && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    void navigate(-1);
                  }}
                >
                  <ChevronLeft className="mr-2 h-4 w-4" />
                  <Trans>Go Back</Trans>
                </Button>
              ))}

            {children}
          </div>
        </div>
      </div>
    </div>
  );
};
