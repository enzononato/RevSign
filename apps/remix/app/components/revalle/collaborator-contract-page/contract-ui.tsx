import { AppError } from '@documenso/lib/errors/app-error';
import {
  REVALLE_COLLABORATOR_CONTRACT_STATUS_LABELS,
  REVALLE_COLLABORATOR_STATUS_LABELS,
  type RevalleCollaboratorContractStatus,
  type RevalleCollaboratorDocStatus,
} from '@documenso/lib/revalle/collaborator-contract';
import { REVALLE_TIME_ZONE } from '@documenso/lib/revalle/date-format';
import { cn } from '@documenso/ui/lib/utils';
import type { ReactNode } from 'react';

import { InvoiceStatePill, type InvoiceTone } from '~/components/revalle/invoice/invoice-ui';

// REVALLE (v.22): peças comuns da página "Contratos para colaboradores" (lista, assistente e acompanhamento).

export const CONTRACTS_PATH = '/contratos-colaboradores';
export const newContractPath = (draftId?: string) =>
  draftId ? `${CONTRACTS_PATH}/novo?id=${encodeURIComponent(draftId)}` : `${CONTRACTS_PATH}/novo`;
export const contractPath = (contractId: string) => `${CONTRACTS_PATH}/${encodeURIComponent(contractId)}`;
/** O PDF do rascunho (para continuar o assistente): rota só do administrador. */
export const contractPdfPath = (contractId: string) => `${CONTRACTS_PATH}/pdf/${encodeURIComponent(contractId)}`;

const CONTRACT_TONES: Record<RevalleCollaboratorContractStatus, InvoiceTone> = {
  DRAFT: 'neutral',
  AWAITING_REPRESENTATIVE: 'warning',
  SENDING: 'warning',
  PAUSED: 'neutral',
  COMPLETED: 'success',
  REJECTED_BY_REPRESENTATIVE: 'danger',
};

export const ContractStatusPill = ({
  status,
  className,
}: {
  status: RevalleCollaboratorContractStatus;
  className?: string;
}) => (
  <InvoiceStatePill tone={CONTRACT_TONES[status]} className={className} testId="contract-status">
    {REVALLE_COLLABORATOR_CONTRACT_STATUS_LABELS[status]}
  </InvoiceStatePill>
);

const DOC_TONES: Record<RevalleCollaboratorDocStatus, InvoiceTone> = {
  QUEUED: 'neutral',
  SENT: 'neutral',
  OPENED: 'warning',
  SIGNED: 'success',
  REJECTED: 'danger',
  FAILED: 'danger',
};

export const DocStatusPill = ({ status, className }: { status: RevalleCollaboratorDocStatus; className?: string }) => (
  <InvoiceStatePill tone={DOC_TONES[status]} className={className}>
    {REVALLE_COLLABORATOR_STATUS_LABELS[status]}
  </InvoiceStatePill>
);

/** Números como no resto da página: 1.204. */
export const formatCount = (value: number) => value.toLocaleString('pt-BR');

/** "23/11 14:02" no fuso de Brasília (o passo do representante). */
export const formatShortDateTime = (date: Date | string) =>
  new Intl.DateTimeFormat('pt-BR', {
    timeZone: REVALLE_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(new Date(date))
    .replace(',', '');

/** A mensagem do servidor (já em português) ou `fallback`. */
export const errorMessage = (err: unknown, fallback: string) => {
  const error = AppError.parseError(err);

  return error.userMessage || error.message || fallback;
};

/** Baixa um texto como arquivo, sem passar pelo servidor. */
export const downloadText = (content: string, fileName: string, type = 'text/csv;charset=utf-8') => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');

  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/** "termo-de-confidencialidade-2026" para nomes de arquivo. */
export const slugify = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'contrato';

export const PageCard = ({
  children,
  className,
  testId,
  as: Tag = 'section',
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
  as?: 'section' | 'div' | 'article';
}) => (
  <Tag
    className={cn('min-w-0 rounded-card bg-card p-5 shadow-card dark:shadow-[0_0_0_1px_hsl(var(--border))]', className)}
    data-testid={testId}
  >
    {children}
  </Tag>
);

export const EmptyState = ({ children, testId }: { children: ReactNode; testId?: string }) => (
  <div
    className="flex flex-col items-center gap-4 rounded-card bg-card px-6 py-10 text-center text-muted-foreground shadow-card"
    data-testid={testId}
  >
    {children}
  </div>
);
