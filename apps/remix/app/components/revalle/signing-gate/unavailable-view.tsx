import { Button } from '@documenso/ui/primitives/button';
import { Trans } from '@lingui/react/macro';
import { CloudOff } from 'lucide-react';

export const UnavailableView = ({ onRetry }: { onRetry: () => void }) => (
  <section className="flex flex-col items-center gap-4 text-center">
    <CloudOff className="h-12 w-12 text-muted-foreground" />
    <p className="text-lg">
      <Trans>Não foi possível confirmar agora. Tente novamente em alguns minutos.</Trans>
    </p>
    <Button type="button" size="lg" className="h-12 w-full text-base" onClick={onRetry}>
      <Trans>Tentar de novo</Trans>
    </Button>
  </section>
);
