import { cn } from '@documenso/ui/lib/utils';
import { Skeleton } from '@documenso/ui/primitives/skeleton';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { DocumentStatus, SigningStatus } from '@prisma/client';
import type { ReactNode } from 'react';

import { FRIENDLY_STATUS_MAP } from '~/components/general/document/document-status';

import { isSlotRecipient, type SlotRecipient } from './recipient-signer-slots';

/**
 * REVALLE v3 (finish review 1, #1): as listas de documentos e da caixa de entrada usam o cartão das linhas de NF em
 * todas as larguras (título e "remetente · data"; encaixes; uma pílula de ação azul ou uma pílula cinza de situação;
 * menu "…"). Continua sendo a `<table>` do DataTable (linhas, células, `thead` com "Selecionar tudo"), só que cada
 * `<tr>` vira um cartão: os testes e leitores de tela seguem vendo uma tabela.
 *
 * O `@container` fica no contêiner da tabela. Lista estreita (< 576px, celular): o cartão empilha e a ação ocupa a
 * largura toda. Média (576–896px, telas de ~1000px): título numa linha, encaixes | ação | menu na de baixo. Larga
 * (>= 896px): uma linha só (título | encaixes | ação | menu), como as NF.
 */
export const documentRowCardTableClassName = ({ withHeader }: { withHeader: boolean }) =>
  cn(
    '@container rounded-none border-0 bg-transparent',
    // A sombra do cartão não pode ser cortada pela rolagem da tabela.
    '[&>div]:overflow-visible',
    '[&_table]:block [&_thead]:block [&_tbody]:flex [&_tbody]:flex-col [&_tbody]:gap-2.5',
    '[&_tr]:flex [&_tr]:h-auto [&_tr]:items-start [&_tr]:border-0 @4xl:[&_tr]:items-center',
    withHeader
      ? '[&_thead_tr]:border-0 [&_thead_tr:hover]:bg-transparent [&_thead_tr]:mb-2.5 [&_thead_tr]:px-4 sm:[&_thead_tr]:pl-[22px]'
      : '[&_thead]:sr-only',
    '[&_th]:h-auto [&_th]:p-0 [&_th]:font-semibold [&_th]:text-[13px] [&_th]:normal-case [&_th]:tracking-normal',
    '[&_tbody_tr]:rounded-card [&_tbody_tr]:bg-card [&_tbody_tr]:px-4 [&_tbody_tr]:py-4 [&_tbody_tr]:shadow-card sm:[&_tbody_tr]:pr-[18px] sm:[&_tbody_tr]:pl-[22px]',
    '[&_tbody_tr:not([data-state=selected]):hover]:bg-card [&_tbody_tr[data-state=selected]]:ring-2 [&_tbody_tr[data-state=selected]]:ring-primary [&_tbody_tr[data-state=selected]]:ring-inset',
    // Larguras fixas das colunas (estilo inline do DataTable) e o corte de texto da célula não valem no cartão.
    '[&_td]:!w-auto [&_td]:overflow-visible [&_td]:whitespace-normal [&_td]:p-0',
    '[&_td:last-child]:min-w-0 [&_td:last-child]:flex-1 [&_td[colspan]]:h-auto',
  );

/** Caixa de seleção da linha, alinhada à primeira linha do título (cartão empilhado) ou ao centro (linha larga). */
export const DocumentRowCardSelect = ({ children }: { children: ReactNode }) => (
  <div className="flex h-[22px] items-center pr-3.5">{children}</div>
);

/**
 * Encaixes e a linha curta: no cartão empilhado, lado a lado (encaixes à esquerda, frase à direita); na linha larga,
 * a frase embaixo dos encaixes. Três encaixes + "+N" numa linha só.
 */
export const DOCUMENT_ROW_SLOTS_CLASS_NAME =
  'flex items-center justify-between gap-3 @xl:block [&>div:first-child]:flex-nowrap [&>p]:mt-0 @xl:[&>p]:mt-[5px]';

export type DocumentRowCardBodyProps = {
  title: ReactNode;
  meta?: ReactNode;
  slots?: ReactNode;
  /** Uma pílula: a ação da linha (azul ou em contorno) ou, sem ação, a pílula de situação. */
  action?: ReactNode;
  menu?: ReactNode;
};

export const DocumentRowCardBody = ({ title, meta, slots, action, menu }: DocumentRowCardBodyProps) => {
  const hasMenu = menu !== undefined && menu !== null && menu !== false;

  return (
    <div
      className={cn(
        'grid min-w-0 items-center gap-x-[18px] gap-y-3',
        hasMenu
          ? "@4xl:grid-cols-[minmax(0,1fr)_150px_168px_44px] @xl:grid-cols-[minmax(0,1fr)_168px_44px] grid-cols-[minmax(0,1fr)_auto] @4xl:[grid-template-areas:'doc_slots_action_menu'] @xl:[grid-template-areas:'doc_doc_doc'_'slots_action_menu'] [grid-template-areas:'doc_menu'_'slots_slots'_'action_action']"
          : "@4xl:grid-cols-[minmax(0,1fr)_150px_168px] @xl:grid-cols-[minmax(0,1fr)_168px] grid-cols-[minmax(0,1fr)] @4xl:[grid-template-areas:'doc_slots_action'] @xl:[grid-template-areas:'doc_doc'_'slots_action'] [grid-template-areas:'doc'_'slots'_'action']",
      )}
      data-testid="document-row-card"
    >
      <div className="min-w-0 [grid-area:doc]">
        <div className="line-clamp-2 break-words font-bold font-sans text-base leading-snug">{title}</div>
        {meta && <div className="mt-1 truncate text-[13px] text-muted-foreground">{meta}</div>}
      </div>

      {hasMenu && (
        <div className="-my-1.5 -mr-1.5 flex self-start @xl:self-center justify-self-end [grid-area:menu]">{menu}</div>
      )}

      <div className="min-w-0 [grid-area:slots]">{slots}</div>

      <div className="min-w-0 [grid-area:action] empty:hidden [&_a]:w-full [&_a]:min-w-0 [&_button]:w-full [&_button]:min-w-0">
        {action}
      </div>
    </div>
  );
};

export type DocumentRowStateTone = 'neutral' | 'success' | 'danger';

/** Pílula de situação (sem ação na linha), como a das NF: cinza, verde quando concluído, vermelho quando recusado. */
export const DocumentRowStatePill = ({
  tone = 'neutral',
  children,
}: {
  tone?: DocumentRowStateTone;
  children: ReactNode;
}) => (
  <div
    className={cn(
      'flex h-11 w-full items-center justify-center rounded-full px-3 text-center font-bold text-[13.5px]',
      tone === 'success' && 'bg-success-bg text-success',
      tone === 'danger' && 'bg-danger-bg text-destructive',
      tone === 'neutral' && 'bg-muted text-muted-foreground',
    )}
    data-testid="document-row-state"
  >
    <span className="min-w-0 truncate">{children}</span>
  </div>
);

export const DocumentRowCardSkeletonBody = ({ withMenu }: { withMenu?: boolean }) => (
  <DocumentRowCardBody
    title={<Skeleton className="my-1 h-4 w-3/4 max-w-[22rem] rounded-full" />}
    meta={<Skeleton className="mt-2 block h-3 w-1/2 max-w-[14rem] rounded-full" />}
    slots={
      <div className="flex gap-[5px]">
        <Skeleton className="h-[30px] w-[30px] rounded-[10px]" />
        <Skeleton className="h-[30px] w-[30px] rounded-[10px]" />
      </div>
    }
    action={<Skeleton className="h-11 w-full rounded-full" />}
    menu={withMenu ? <div className="h-11 w-11" /> : undefined}
  />
);

export type DocumentRowStateProps = {
  status: DocumentStatus;
  recipients: SlotRecipient[];
};

/**
 * A pílula cinza de quando a linha não tem ação para você: quem falta ("Aguardando Fulano"), ou o status (verde se
 * concluído, vermelho se recusado).
 */
export const DocumentRowState = ({ status, recipients }: DocumentRowStateProps) => {
  const { _ } = useLingui();

  if (status === DocumentStatus.COMPLETED) {
    return <DocumentRowStatePill tone="success">{_(FRIENDLY_STATUS_MAP.COMPLETED.label)}</DocumentRowStatePill>;
  }

  if (status === DocumentStatus.REJECTED) {
    return <DocumentRowStatePill tone="danger">{_(FRIENDLY_STATUS_MAP.REJECTED.label)}</DocumentRowStatePill>;
  }

  if (status === DocumentStatus.PENDING) {
    const next = recipients.find(
      (recipient) => isSlotRecipient(recipient) && recipient.signingStatus === SigningStatus.NOT_SIGNED,
    );

    if (next) {
      const name = next.name.trim().split(/\s+/)[0] || next.email.split('@')[0];

      return (
        <DocumentRowStatePill>
          <Trans>Waiting for {name}</Trans>
        </DocumentRowStatePill>
      );
    }
  }

  return <DocumentRowStatePill>{_(FRIENDLY_STATUS_MAP[status].label)}</DocumentRowStatePill>;
};
