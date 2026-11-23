import { getOptionalSession } from '@documenso/auth/server/lib/utils/get-session';
import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import { isAdmin } from '@documenso/lib/utils/is-admin';
import { prisma } from '@documenso/prisma';

import type { Route } from './+types/contratos-colaboradores.pdf.$id';

const text = (body: string, status: number) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

/**
 * REVALLE (v.22): o PDF subido no assistente, para a prévia ao continuar um rascunho. Só o administrador do sistema (o
 * mesmo alcance da página) e só pelo id do contrato: nunca um DocumentData qualquer.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { user } = await getOptionalSession(request);

  if (!user) {
    return text('Entre no RevSign.', 401);
  }

  if (!isAdmin(user)) {
    return text('Só o administrador pode fazer isso.', 403);
  }

  const contract = await prisma.revalleCollaboratorContract.findUnique({
    where: { id: params.id },
    select: { sourcePdfDocumentDataId: true },
  });

  const documentData = contract?.sourcePdfDocumentDataId
    ? await prisma.documentData.findUnique({
        where: { id: contract.sourcePdfDocumentDataId },
        select: { type: true, data: true },
      })
    : null;

  if (!documentData) {
    return text('Não encontrado.', 404);
  }

  return new Response(await getFileServerSide(documentData), {
    headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'private, no-store' },
  });
}
