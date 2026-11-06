import { costCenterLabel, costCenterName } from '@documenso/lib/revalle/invoice/cost-centers';
import { cn } from '@documenso/ui/lib/utils';
import { Trans, useLingui } from '@lingui/react/macro';
import { createContext, type ReactNode, useContext } from 'react';

export type SigningInvoiceAccount = {
  account: { code: string; name: string } | null;
  costCenter: { code: string; name: string } | null;
};

const SigningInvoiceAccountContext = createContext<SigningInvoiceAccount | null>(null);

/**
 * A conta e o centro da NF chegam pelo loader da página de assinatura (só depois do portão) e descem por contexto até as telas V1 e
 * V2, que só ganham uma linha cada. Fora da página de assinatura (embed, modelo direto) não há provedor: nada aparece.
 */
export const SigningInvoiceAccountProvider = ({
  account,
  children,
}: {
  account: SigningInvoiceAccount | null | undefined;
  children: ReactNode;
}) => <SigningInvoiceAccountContext.Provider value={account ?? null}>{children}</SigningInvoiceAccountContext.Provider>;

/** A NF aberta para quem assina (null fora de NF ou fora da página de assinatura). */
export const useSigningInvoiceAccount = () => useContext(SigningInvoiceAccountContext);

/**
 * Fase 6: quem assina vê a conta contábil da NF, que faz parte do que é assinado e fica na prova. Fase 7: o centro de
 * custo vai na mesma frase, e vale em separado: NF sem centro mostra só a conta, e NF sem conta (marcada depois do envio)
 * mostra só o centro.
 *
 * Redesign v3: o bloco "O que você está assinando" mostra a conta e o centro em linhas. A frase de sempre continua no HTML,
 * inteira, como texto do leitor de tela (as linhas são só a apresentação dela). Valor, fornecedor e número lidos pela IA
 * não entram aqui: não fazem parte do que é assinado (revalle/docs/verificacao.md).
 */
export const SigningInvoiceAccountBlock = ({
  className,
  titleClassName,
}: {
  className?: string;
  titleClassName?: string;
}) => {
  const invoice = useSigningInvoiceAccount();
  const { t } = useLingui();

  if (!invoice) {
    return null;
  }

  const { account, costCenter } = invoice;
  const label = account?.name ? `${account.code} – ${account.name}` : (account?.code ?? null);
  const centerLabel = costCenter ? costCenterLabel(costCenter.code) : null;

  const sentence = () => {
    if (label && centerLabel) {
      return t`Nota fiscal · Conta contábil: ${label} · Centro de custo: ${centerLabel}`;
    }

    return label ? t`Nota fiscal · Conta contábil: ${label}` : t`Nota fiscal · Centro de custo: ${centerLabel}`;
  };

  return (
    <section className={className} aria-labelledby="revalle-signing-what">
      <h2
        id="revalle-signing-what"
        className={cn('mb-1 font-display font-extrabold text-[15px] tracking-[-0.01em]', titleClassName)}
      >
        <Trans>What you are signing</Trans>
      </h2>

      <div data-testid="invoice-signing-account">
        {/* Um só nó de texto: a frase sai inteira no HTML do servidor. */}
        <span className="sr-only">{sentence()}</span>

        <dl aria-hidden className="divide-y divide-border">
          {account && (
            <SigningInvoiceRow label={<Trans>Conta contábil</Trans>} code={account.code} name={account.name || null} />
          )}

          {costCenter && (
            <SigningInvoiceRow
              label={<Trans>Centro de custo</Trans>}
              code={costCenter.code}
              name={costCenterName(costCenter.code)}
            />
          )}
        </dl>
      </div>
    </section>
  );
};

const SigningInvoiceRow = ({ label, code, name }: { label: ReactNode; code: string; name: string | null }) => (
  <div className="flex items-baseline justify-between gap-4 py-2.5 last:pb-0.5">
    <dt className="flex-shrink-0 text-[14px] text-muted-foreground">{label}</dt>
    <dd className="min-w-0 break-words text-right font-semibold text-[14.5px] leading-snug">
      <span className="mr-1.5 font-display font-extrabold text-[13.5px] text-brand-text tabular-nums">{code}</span>
      {name}
    </dd>
  </div>
);
