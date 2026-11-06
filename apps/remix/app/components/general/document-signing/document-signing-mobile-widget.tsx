import { Button } from '@documenso/ui/primitives/button';

import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { RecipientRole } from '@prisma/client';
import { LucideChevronDown, LucideChevronUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { match } from 'ts-pattern';

import { useEmbedSigningContext } from '~/components/embed/embed-signing-context';

import { BrandingLogo } from '../branding-logo';
import EnvelopeSignerForm from '../envelope-signing/envelope-signer-form';
import { EnvelopeSignerCompleteDialog } from '../envelope-signing/envelope-signing-complete-dialog';
import { useRequiredEnvelopeSigningContext } from './envelope-signing-provider';

export const DocumentSigningMobileWidget = () => {
  const { t } = useLingui();
  const [isExpanded, setIsExpanded] = useState(false);

  const { hidePoweredBy = true } = useEmbedSigningContext() || {};

  const { recipientFieldsRemaining, recipient } = useRequiredEnvelopeSigningContext();

  /**
   * Pre open the widget for assistants to let them know it's there.
   */
  useEffect(() => {
    if (recipient.role === RecipientRole.ASSISTANT) {
      setIsExpanded(true);
    }
  }, []);

  const note =
    recipientFieldsRemaining.length === 0 ? (
      match(recipient.role)
        .with(RecipientRole.VIEWER, () => <Trans>Please mark as viewed to complete</Trans>)
        .with(RecipientRole.SIGNER, () => <Trans>Please complete the document once reviewed</Trans>)
        .with(RecipientRole.APPROVER, () => <Trans>Please complete the document once reviewed</Trans>)
        .with(RecipientRole.ASSISTANT, () => <Trans>Please complete the document once reviewed</Trans>)
        .otherwise(() => null)
    ) : (
      <Plural value={recipientFieldsRemaining.length} one="1 Field Remaining" other="# Fields Remaining" />
    );

  // REVALLE (redesign v3): barra fixa do preview do celular: a nota da etapa e a pílula de 54px com a ação de sempre
  // (próximo campo / concluir, com a mesma validação). A seta abre os dados de quem assina (nome e assinatura).
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 bg-card shadow-[0_-1px_0_hsl(var(--border)),0_-8px_24px_-12px_rgba(20,27,46,0.18)]">
      <div className="mx-auto w-full max-w-[760px] px-4 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        {isExpanded && (
          <div className="slide-in-from-bottom-2 mb-3 max-h-[55vh] animate-in overflow-y-auto border-border border-b pb-4 duration-200">
            <h2 className="sr-only">
              <Trans>Sign Document</Trans>
            </h2>

            <EnvelopeSignerForm />

            {!hidePoweredBy && (
              <div className="mt-2 inline-block rounded bg-primary px-2 py-1 font-medium text-primary-foreground text-xs opacity-60 hover:opacity-100 lg:hidden">
                <span>
                  <Trans>Powered by</Trans>
                </span>
                <BrandingLogo className="ml-2 inline-block h-[14px]" />
              </div>
            )}
          </div>
        )}

        {/* Linha baixa (a seta tem 44px de toque, mas -my-3 não empurra a barra): a barra cabe na folga do rodapé
            "Código-fonte", que fica visível acima dela no fim da página. */}
        <div className="mb-2 flex min-h-5 items-center gap-2">
          {recipient.role !== RecipientRole.VIEWER && (
            <Button
              variant="ghost"
              onClick={() => setIsExpanded(!isExpanded)}
              // REVALLE: h-11 w-11 p-0 (44 px de área de toque; era h-8 w-8)
              className="-my-3 flex h-11 w-11 flex-shrink-0 items-center justify-center p-0"
              // REVALLE: rótulo do leitor de tela traduzido (era 'Collapse'/'Expand' fixo em inglês)
              aria-label={isExpanded ? t`Collapse` : t`Expand`}
              aria-expanded={isExpanded}
            >
              {isExpanded ? (
                <LucideChevronDown className="h-5 w-5 flex-shrink-0 text-muted-foreground" />
              ) : (
                <LucideChevronUp className="h-5 w-5 flex-shrink-0 text-muted-foreground" />
              )}
            </Button>
          )}

          <p
            className="flex-1 text-center font-medium text-[12.5px] text-muted-foreground tabular-nums"
            aria-live="polite"
          >
            {note}
          </p>
        </div>

        <EnvelopeSignerCompleteDialog buttonSize="lg" triggerClassName="text-[17px]" />
      </div>
    </div>
  );
};
