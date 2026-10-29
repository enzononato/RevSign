import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error'; // REVALLE:
import { REVALLE_SHARE_LINKS_DISABLED } from '@documenso/lib/revalle/share-links'; // REVALLE:
import { createOrGetShareLink } from '@documenso/lib/server-only/share/create-or-get-share-link';

import { procedure } from '../trpc';
import { ZShareDocumentRequestSchema, ZShareDocumentResponseSchema } from './share-document.types';

// Note: This is an unauthenticated route.
export const shareDocumentRoute = procedure
  .input(ZShareDocumentRequestSchema)
  .output(ZShareDocumentResponseSchema)
  .mutation(async ({ input, ctx }) => {
    // REVALLE: sem link público de compartilhamento (nada é gravado), nem com token nem logado.
    if (REVALLE_SHARE_LINKS_DISABLED) {
      throw new AppError(AppErrorCode.FORBIDDEN, {
        message: 'Links de compartilhamento estão desativados no RevSign.',
      });
    }

    const { documentId, token } = input;

    ctx.logger.info({
      input: {
        documentId,
      },
    });

    if (token) {
      return await createOrGetShareLink({ documentId, token });
    }

    if (!ctx.user?.id) {
      throw new Error('You must either provide a token or be logged in to create a sharing link.');
    }

    return await createOrGetShareLink({ documentId, userId: ctx.user.id });
  });
