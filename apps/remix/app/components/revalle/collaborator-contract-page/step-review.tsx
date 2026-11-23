import { REVALLE_COLLABORATOR_DEFAULT_SENDER_NAME } from '@documenso/lib/revalle/collaborator-contract';
import { estimateSendHours } from '@documenso/lib/revalle/collaborator-rows';
import { Button } from '@documenso/ui/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@documenso/ui/primitives/dialog';
import { Input } from '@documenso/ui/primitives/input';
import { Label } from '@documenso/ui/primitives/label';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { type ReactNode, useId } from 'react';

import { formatCount } from './contract-ui';

// REVALLE (v.22): último passo: o resumo, o nome do remetente, a estimativa e a confirmação antes de enviar.

export type StepReviewProps = {
  title: string;
  pageCount: number | null;
  representativeEmail: string;
  representativeAccountName: string | null;
  readyCount: number;
  skippedCount: number;
  senderName: string;
  onSenderNameChange: (value: string) => void;
  perHour: number;
  onEditStep: (step: number) => void;
};

export const StepReview = ({
  title,
  pageCount,
  representativeEmail,
  representativeAccountName,
  readyCount,
  skippedCount,
  senderName,
  onSenderNameChange,
  perHour,
  onEditStep,
}: StepReviewProps) => {
  const { t } = useLingui();

  const senderId = useId();
  const sender = senderName.trim() || REVALLE_COLLABORATOR_DEFAULT_SENDER_NAME;
  const hours = estimateSendHours(readyCount, perHour);
  const perHourLabel = formatCount(perHour);
  const subject = `${sender} enviou "${title.trim()}" para você assinar`;

  return (
    <div className="flex flex-col gap-6" data-testid="wizard-step-review">
      <dl className="grid gap-x-6 sm:grid-cols-[200px_minmax(0,1fr)]">
        <ReviewRow label={<Trans>Título</Trans>} onEdit={() => onEditStep(0)} testId="review-title">
          {title.trim()}
        </ReviewRow>
        <ReviewRow label={<Trans>Páginas</Trans>} onEdit={() => onEditStep(0)} testId="review-pages">
          {pageCount === null ? '—' : formatCount(pageCount)}
        </ReviewRow>
        <ReviewRow label={<Trans>Representante</Trans>} onEdit={() => onEditStep(1)} testId="review-representative">
          {representativeAccountName ? (
            <>
              {representativeAccountName}{' '}
              <span className="font-normal text-muted-foreground">({representativeEmail.trim()})</span>
            </>
          ) : (
            representativeEmail.trim()
          )}
        </ReviewRow>
        <ReviewRow label={<Trans>Colaboradores</Trans>} onEdit={() => onEditStep(2)} testId="review-collaborators">
          {t`${plural(readyCount, { one: '# colaborador', other: '# colaboradores' })}`}
          {skippedCount > 0 && (
            <span className="block font-normal text-muted-foreground text-sm">
              {t`${plural(skippedCount, {
                one: '# linha com erro fica de fora',
                other: '# linhas com erro ficam de fora',
              })}`}
            </span>
          )}
        </ReviewRow>
        <ReviewRow label={<Trans>Estimativa de envio</Trans>} testId="review-estimate">
          {hours <= 1 ? (
            <Trans>cerca de 1 hora, {perHourLabel} e-mails por hora</Trans>
          ) : (
            <Trans>
              cerca de {hours} horas, {perHourLabel} e-mails por hora
            </Trans>
          )}
          <span className="block font-normal text-muted-foreground text-sm">
            <Trans>O envio começa sozinho quando o representante assinar.</Trans>
          </span>
        </ReviewRow>
      </dl>

      <div className="flex max-w-xl flex-col gap-1.5">
        <Label htmlFor={senderId}>
          <Trans>Nome do remetente</Trans>
        </Label>
        <Input
          id={senderId}
          value={senderName}
          maxLength={100}
          placeholder={REVALLE_COLLABORATOR_DEFAULT_SENDER_NAME}
          aria-describedby={`${senderId}-help`}
          onChange={(event) => onSenderNameChange(event.target.value)}
          data-testid="review-sender-name"
        />
        <p id={`${senderId}-help`} className="text-muted-foreground text-sm">
          <Trans>Aparece nos e-mails. Assunto:</Trans>{' '}
          <span className="font-semibold text-foreground" data-testid="review-subject">
            {subject}
          </span>
        </p>
      </div>
    </div>
  );
};

const ReviewRow = ({
  label,
  children,
  onEdit,
  testId,
}: {
  label: ReactNode;
  children: ReactNode;
  onEdit?: () => void;
  testId?: string;
}) => (
  <>
    <dt className="pt-3 text-muted-foreground text-sm sm:border-border sm:border-b sm:pb-3">{label}</dt>
    <dd
      className="flex items-start justify-between gap-3 border-border border-b pb-3 font-semibold sm:pt-3"
      data-testid={testId}
    >
      <span className="min-w-0 break-words">{children}</span>
      {onEdit && (
        <Button type="button" variant="link" size="sm" className="h-auto shrink-0 px-0 py-0" onClick={onEdit}>
          <Trans>Alterar</Trans>
        </Button>
      )}
    </dd>
  </>
);

export type ConfirmSendDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  readyCount: number;
  isSending: boolean;
  error: string | null;
  onConfirm: () => void;
};

/** "Enviar para o representante e, depois que ele assinar, para {n} colaboradores?" */
export const ConfirmSendDialog = ({
  open,
  onOpenChange,
  readyCount,
  isSending,
  error,
  onConfirm,
}: ConfirmSendDialogProps) => {
  const { t } = useLingui();

  return (
    <Dialog open={open} onOpenChange={(value) => !isSending && onOpenChange(value)}>
      <DialogContent data-testid="confirm-send-dialog">
        <DialogHeader>
          <DialogTitle>
            {t`${plural(readyCount, {
              one: 'Enviar para o representante e, depois que ele assinar, para # colaborador?',
              other: 'Enviar para o representante e, depois que ele assinar, para # colaboradores?',
            })}`}
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Depois de enviar não dá para mudar o contrato nem a lista. Se precisar parar, use Pausar envio na página
              do contrato.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p className="text-destructive text-sm" role="alert" data-testid="confirm-send-error">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" disabled={isSending} onClick={() => onOpenChange(false)}>
            <Trans>Cancelar</Trans>
          </Button>
          <Button type="button" loading={isSending} onClick={onConfirm} data-testid="confirm-send">
            <Trans>Enviar</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
