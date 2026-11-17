import { useCurrentEnvelopeEditor } from '@documenso/lib/client-only/providers/envelope-editor-provider';
import { DO_NOT_INVALIDATE_QUERY_ON_MUTATION } from '@documenso/lib/constants/trpc';
import { type AnnotationBoxRect, clampAnnotationBox } from '@documenso/lib/revalle/invoice/annotation-box';
import { trpc } from '@documenso/trpc/react';
import type { TAnnotationBox } from '@documenso/trpc/server/revalle-router/invoice/annotation-box.types';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { useLingui } from '@lingui/react/macro';
import { DocumentStatus } from '@prisma/client';
import { useEffect, useRef } from 'react';

const SAVE_DEBOUNCE_MS = 400;

const EMPTY_BOXES: TAnnotationBox[] = [];

// Uma fila só para o editor inteiro: a paleta (pôr) e cada página (mover, tirar) usam instâncias diferentes do hook, e a
// última gravação do bloco precisa chegar por último.
let saveQueue: Promise<unknown> = Promise.resolve();

const enqueue = (write: () => Promise<unknown>) => {
  const next = saveQueue.then(write);

  saveQueue = next.catch(() => undefined);

  return next;
};

/**
 * O bloco "Conta e centro de custo" de cada arquivo do rascunho aberto no editor. O cache da consulta `find` é o estado
 * dividido entre a paleta e as páginas: cada mudança vai para ele na hora e para o servidor em seguida (mover e
 * redimensionar esperam a pessoa parar). Fora de rascunho e em envio de antes do bloco (`autoAnnotation`), o bloco não
 * existe no editor.
 */
export const useAnnotationBoxes = () => {
  const { t } = useLingui();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const { envelope } = useCurrentEnvelopeEditor();

  const envelopeId = envelope.id;
  // Modelo também: o documento criado a partir dele leva o bloco de cada arquivo.
  const isDraft = envelope.status === DocumentStatus.DRAFT;

  const { data, refetch } = trpc.revalle.invoice.annotationBox.find.useQuery(
    { envelopeId },
    { ...DO_NOT_INVALIDATE_QUERY_ON_MUTATION, enabled: isDraft },
  );

  const { mutateAsync: saveBox } = trpc.revalle.invoice.annotationBox.set.useMutation(
    DO_NOT_INVALIDATE_QUERY_ON_MUTATION,
  );
  const { mutateAsync: deleteBox } = trpc.revalle.invoice.annotationBox.delete.useMutation(
    DO_NOT_INVALIDATE_QUERY_ON_MUTATION,
  );

  const boxes = data?.boxes ?? EMPTY_BOXES;
  const isEnabled = isDraft && data !== undefined && !data.autoAnnotation;

  // Trocar o PDF de um arquivo apaga o bloco dele no servidor: relê quando os arquivos mudam.
  const itemsKey = envelope.envelopeItems.map((item) => `${item.id}:${item.documentDataId}`).join(',');
  const lastItemsKey = useRef(itemsKey);

  useEffect(() => {
    if (lastItemsKey.current === itemsKey || !isDraft) {
      return;
    }

    lastItemsKey.current = itemsKey;
    void refetch();
  }, [itemsKey]);

  const pending = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; rect: AnnotationBoxRect }>());

  const writeCache = (envelopeItemId: string, rect: AnnotationBoxRect | null) =>
    utils.revalle.invoice.annotationBox.find.setData({ envelopeId }, (current) => {
      const others = (current?.boxes ?? []).filter((box) => box.envelopeItemId !== envelopeItemId);

      return {
        autoAnnotation: current?.autoAnnotation ?? false,
        boxes: rect ? [...others, { envelopeItemId, ...rect }] : others,
      };
    });

  const onSaveError = () => {
    toast({
      title: t`Não foi possível salvar o bloco de conta e centro. Tente de novo.`,
      variant: 'destructive',
      duration: 5000,
    });

    void refetch();
  };

  const save = (envelopeItemId: string, rect: AnnotationBoxRect) =>
    void enqueue(async () => await saveBox({ envelopeId, envelopeItemId, rect })).catch(onSaveError);

  const cancelPending = (envelopeItemId: string) => {
    const entry = pending.current.get(envelopeItemId);

    if (entry) {
      clearTimeout(entry.timer);
      pending.current.delete(envelopeItemId);
    }
  };

  // A página saiu da tela (lista virtual) ou o editor fechou: grava o que ainda esperava.
  useEffect(
    () => () => {
      for (const [envelopeItemId, { timer, rect }] of pending.current) {
        clearTimeout(timer);
        save(envelopeItemId, rect);
      }

      pending.current.clear();
    },
    [],
  );

  /** Põe o bloco no arquivo (ou move o que já existe para lá) e grava na hora. */
  const placeBox = (envelopeItemId: string, rect: AnnotationBoxRect) => {
    const clamped = clampAnnotationBox(rect);

    cancelPending(envelopeItemId);
    writeCache(envelopeItemId, clamped);
    save(envelopeItemId, clamped);
  };

  /** Arrastou ou redimensionou: o cache muda na hora, o servidor quando a pessoa para. */
  const moveBox = (envelopeItemId: string, rect: AnnotationBoxRect) => {
    const clamped = clampAnnotationBox(rect);

    cancelPending(envelopeItemId);
    writeCache(envelopeItemId, clamped);

    pending.current.set(envelopeItemId, {
      rect: clamped,
      timer: setTimeout(() => {
        pending.current.delete(envelopeItemId);
        save(envelopeItemId, clamped);
      }, SAVE_DEBOUNCE_MS),
    });
  };

  const removeBox = (envelopeItemId: string) => {
    cancelPending(envelopeItemId);
    writeCache(envelopeItemId, null);

    void enqueue(async () => await deleteBox({ envelopeId, envelopeItemId })).catch(onSaveError);
  };

  const boxOf = (envelopeItemId: string | null | undefined) =>
    boxes.find((box) => box.envelopeItemId === envelopeItemId) ?? null;

  return { isEnabled, boxOf, placeBox, moveBox, removeBox };
};
