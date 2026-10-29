import { useAnalytics } from '@documenso/lib/client-only/hooks/use-analytics';
import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@documenso/ui/primitives/dialog';
import { Form, FormControl, FormField, FormItem, FormMessage } from '@documenso/ui/primitives/form/form';
import { Textarea } from '@documenso/ui/primitives/textarea';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { zodResolver } from '@hookform/resolvers/zod';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useRef, useState } from 'react'; // REVALLE: useRef
import { useForm } from 'react-hook-form';
import { useSearchParams } from 'react-router';
import { z } from 'zod';

const ZRejectDocumentFormSchema = z.object({
  reason: z.string().max(500, msg`Reason must be less than 500 characters`),
});

type TRejectDocumentFormSchema = z.infer<typeof ZRejectDocumentFormSchema>;

export interface DocumentSigningRejectDialogProps {
  documentId: number;
  token: string;
  onRejected?: (reason: string) => void | Promise<void>;
  trigger?: React.ReactNode;
  onOpenChange?: (open: boolean) => void; // REVALLE: o menu "Ações" do celular fecha junto com o diálogo
}

export function DocumentSigningRejectDialog({
  documentId,
  token,
  onRejected,
  trigger,
  onOpenChange, // REVALLE:
}: DocumentSigningRejectDialogProps) {
  const { t } = useLingui();
  const { toast } = useToast();
  const analytics = useAnalytics();
  const [searchParams] = useSearchParams();

  const [isOpen, setIsOpen] = useState(false);

  const { mutateAsync: rejectDocumentWithToken } = trpc.recipient.rejectDocumentWithToken.useMutation();

  const form = useForm<TRejectDocumentFormSchema>({
    resolver: zodResolver(ZRejectDocumentFormSchema),
    defaultValues: {
      reason: '',
    },
  });

  const onRejectDocument = async ({ reason }: TRejectDocumentFormSchema) => {
    try {
      await rejectDocumentWithToken({
        documentId,
        token,
        reason,
      });

      toast({
        title: t`Document rejected`,
        description: t`The document has been successfully rejected.`,
        duration: 5000,
      });

      setIsOpen(false);

      if (onRejected) {
        await onRejected(reason);
      } else {
        window.location.href = `/sign/${token}/rejected`;
      }
    } catch (err) {
      analytics.captureException(err, {
        source: 'signing',
        location: 'reject_document',
        documentId,
      });

      toast({
        title: t`Error`,
        description: t`An error occurred while rejecting the document. Please try again.`,
        variant: 'destructive',
        duration: 5000,
      });
    }
  };

  useEffect(() => {
    if (searchParams?.get('reject') === 'true') {
      setIsOpen(true);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      form.reset();
    }
  }, [isOpen]);

  // REVALLE: avisa quem abriu o diálogo quando ele abre ou fecha, inclusive pelo "Cancelar" (que não passa pelo
  // onOpenChange do Dialog). Só nas mudanças: este componente monta dentro do menu "Ações" do celular, e avisar o
  // "fechado" inicial fecharia o menu assim que ele abre.
  const wasOpenRef = useRef(isOpen);

  useEffect(() => {
    if (wasOpenRef.current !== isOpen) {
      wasOpenRef.current = isOpen;
      onOpenChange?.(isOpen);
    }
  }, [isOpen]);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline">
            <Trans>Reject Document</Trans>
          </Button>
        )}
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Reject Document</Trans>
          </DialogTitle>

          <DialogDescription>
            <Trans>Are you sure you want to reject this document? This action cannot be undone.</Trans>
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onRejectDocument)} className="space-y-4">
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <Textarea
                      {...field}
                      rows={4}
                      placeholder={t`Please provide a reason for rejecting this document`}
                      disabled={form.formState.isSubmitting}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setIsOpen(false)}
                disabled={form.formState.isSubmitting}
              >
                <Trans>Cancel</Trans>
              </Button>

              <Button
                type="submit"
                variant="destructive"
                loading={form.formState.isSubmitting}
                disabled={!form.formState.isValid}
              >
                <Trans>Reject Document</Trans>
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
