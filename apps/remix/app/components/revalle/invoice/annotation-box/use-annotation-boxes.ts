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

// Estado do módulo, não da instância: a paleta (pôr) e cada página (mover, tirar) usam instâncias diferentes do hook, as
// páginas saem da tela (lista virtual) com uma gravação ainda esperando, e o diálogo de envio precisa de tudo gravado
// antes de classificar (`flushAnnotationBoxSaves`). Uma fila só: a última gravação de um bloco chega por último.
let saveQueue: Promise<unknown> = Promise.resolve();
const pendingSaves = new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => void }>();
// Cada mudança feita na tela muda a versão do bloco; a resposta de uma gravação só vai para o cache se nada mudou depois.
const localVersions = new Map<string, number>();

const enqueue = <T>(write: () => Promise<T>) => {
  const next = saveQueue.then(write);

  saveQueue = next.catch(() => undefined);

  return next;
};

const cancelPendingSave = (envelopeItemId: string) => {
  const entry = pendingSaves.get(envelopeItemId);

  if (entry) {
    clearTimeout(entry.timer);
    pendingSaves.delete(envelopeItemId);
  }
};

const bumpVersion = (envelopeItemId: string) => {
  const version = (localVersions.get(envelopeItemId) ?? 0) + 1;

  localVersions.set(envelopeItemId, version);

  return version;
};

/** Grava agora o que esperava a pessoa parar de mexer no bloco, e espera a fila de gravações terminar. */
export const flushAnnotationBoxSaves = async () => {
  for (const [envelopeItemId, entry] of [...pendingSaves]) {
    clearTimeout(entry.timer);
    pendingSaves.delete(envelopeItemId);
    entry.run();
  }

  await saveQueue;
};

type UseAnnotationBoxesOptions = {
  /** Relê os blocos do servidor ao montar (a paleta: a cada vez que o passo "Adicionar campos" abre). */
  refetchOnMount?: boolean;
};

/**
 * O bloco "Conta e centro de custo" de cada arquivo do rascunho aberto no editor. O cache da consulta `find` é o estado
 * dividido entre a paleta e as páginas: cada mudança vai para ele na hora e para o servidor em seguida (mover e
 * redimensionar esperam a pessoa parar). O cache só é relido de propósito (paleta montada, arquivos trocados, erro):
 * uma releitura no meio de uma gravação traria o lugar antigo de volta. Fora de rascunho e em envio de antes do bloco
 * (`autoAnnotation`), o bloco não existe no editor.
 */
export const useAnnotationBoxes = ({ refetchOnMount = false }: UseAnnotationBoxesOptions = {}) => {
  const { t } = useLingui();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const { envelope } = useCurrentEnvelopeEditor();

  const envelopeId = envelope.id;
  // Modelo também: o documento criado a partir dele leva o bloco de cada arquivo.
  const isDraft = envelope.status === DocumentStatus.DRAFT;
  const findUtils = utils.revalle.invoice.annotationBox.find;

  const { data } = trpc.revalle.invoice.annotationBox.find.useQuery(
    { envelopeId },
    {
      ...DO_NOT_INVALIDATE_QUERY_ON_MUTATION,
      enabled: isDraft,
      staleTime: Number.POSITIVE_INFINITY,
      refetchOnWindowFocus: false,
    },
  );

  const boxes = data?.boxes ?? EMPTY_BOXES;
  const isEnabled = isDraft && data !== undefined && !data.autoAnnotation;

  const reload = async () => {
    await flushAnnotationBoxSaves();
    await findUtils.refetch({ envelopeId });
  };

  useEffect(() => {
    if (refetchOnMount && isDraft) {
      void reload();
    }
  }, []);

  // Trocar o PDF de um arquivo apaga o bloco dele no servidor: relê quando os arquivos mudam.
  const itemsKey = envelope.envelopeItems.map((item) => `${item.id}:${item.documentDataId}`).join(',');
  const lastItemsKey = useRef(itemsKey);

  useEffect(() => {
    if (lastItemsKey.current === itemsKey || !isDraft) {
      return;
    }

    lastItemsKey.current = itemsKey;
    void reload();
  }, [itemsKey]);

  // Uma leitura em andamento não pode sobrescrever o que acabou de mudar na tela: cancela antes.
  const writeCache = (envelopeItemId: string, rect: AnnotationBoxRect | null) => {
    void findUtils.cancel({ envelopeId });
    findUtils.setData({ envelopeId }, (current) => {
      const others = (current?.boxes ?? []).filter((box) => box.envelopeItemId !== envelopeItemId);

      return {
        autoAnnotation: current?.autoAnnotation ?? false,
        boxes: rect ? [...others, { envelopeItemId, ...rect }] : others,
      };
    });
  };

  const onSaveError = () => {
    toast({
      title: t`Não foi possível salvar o bloco de conta e centro. Tente de novo.`,
      variant: 'destructive',
      duration: 5000,
    });

    void findUtils.refetch({ envelopeId });
  };

  // O cliente do tRPC (não o `useMutation`): a gravação esperando continua depois que a página sai da tela.
  const save = (envelopeItemId: string, rect: AnnotationBoxRect) => {
    const version = localVersions.get(envelopeItemId);

    void enqueue(
      async () => await utils.client.revalle.invoice.annotationBox.set.mutate({ envelopeId, envelopeItemId, rect }),
    )
      .then((saved) => {
        if (localVersions.get(envelopeItemId) === version) {
          writeCache(envelopeItemId, saved);
        }
      })
      .catch(onSaveError);
  };

  /** Põe o bloco no arquivo (ou move o que já existe para lá) e grava na hora. */
  const placeBox = (envelopeItemId: string, rect: AnnotationBoxRect) => {
    const clamped = clampAnnotationBox(rect);

    cancelPendingSave(envelopeItemId);
    bumpVersion(envelopeItemId);
    writeCache(envelopeItemId, clamped);
    save(envelopeItemId, clamped);
  };

  /** Arrastou ou redimensionou: o cache muda na hora, o servidor quando a pessoa para. */
  const moveBox = (envelopeItemId: string, rect: AnnotationBoxRect) => {
    const clamped = clampAnnotationBox(rect);
    const run = () => save(envelopeItemId, clamped);

    cancelPendingSave(envelopeItemId);
    bumpVersion(envelopeItemId);
    writeCache(envelopeItemId, clamped);

    pendingSaves.set(envelopeItemId, {
      run,
      timer: setTimeout(() => {
        pendingSaves.delete(envelopeItemId);
        run();
      }, SAVE_DEBOUNCE_MS),
    });
  };

  const removeBox = (envelopeItemId: string) => {
    cancelPendingSave(envelopeItemId);
    bumpVersion(envelopeItemId);
    writeCache(envelopeItemId, null);

    void enqueue(
      async () => await utils.client.revalle.invoice.annotationBox.delete.mutate({ envelopeId, envelopeItemId }),
    ).catch(onSaveError);
  };

  const boxOf = (envelopeItemId: string | null | undefined) =>
    boxes.find((box) => box.envelopeItemId === envelopeItemId) ?? null;

  return { isEnabled, boxOf, placeBox, moveBox, removeBox };
};
