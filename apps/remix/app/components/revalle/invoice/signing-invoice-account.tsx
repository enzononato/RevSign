import { cn } from '@documenso/ui/lib/utils';
import { useLingui } from '@lingui/react/macro';
import { ReceiptTextIcon } from 'lucide-react';
import { createContext, type ReactNode, useContext } from 'react';

export type SigningInvoiceAccount = { code: string; name: string };

const SigningInvoiceAccountContext = createContext<SigningInvoiceAccount | null>(null);

/**
 * A conta da NF chega pelo loader da página de assinatura (só depois do portão) e desce por contexto até as telas V1 e
 * V2, que só ganham uma linha cada. Fora da página de assinatura (embed, modelo direto) não há provedor: nada aparece.
 */
export const SigningInvoiceAccountProvider = ({
  account,
  children,
}: {
  account: SigningInvoiceAccount | null | undefined;
  children: ReactNode;
}) => <SigningInvoiceAccountContext.Provider value={account ?? null}>{children}</SigningInvoiceAccountContext.Provider>;

/** Fase 6: quem assina vê a conta contábil da NF, que faz parte do que é assinado e fica na prova. */
export const SigningInvoiceAccountBlock = ({ className }: { className?: string }) => {
  const account = useContext(SigningInvoiceAccountContext);
  const { t } = useLingui();

  if (!account) {
    return null;
  }

  const label = account.name ? `${account.code} – ${account.name}` : account.code;

  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border border-border bg-background px-3 py-2 text-muted-foreground text-sm',
        className,
      )}
      data-testid="invoice-signing-account"
    >
      <ReceiptTextIcon aria-hidden className="mt-0.5 h-4 w-4 flex-shrink-0" />
      {/* Um só nó de texto: a frase sai inteira no HTML do servidor. */}
      <span className="min-w-0 break-words">{t`Nota fiscal · Conta contábil: ${label}`}</span>
    </div>
  );
};
