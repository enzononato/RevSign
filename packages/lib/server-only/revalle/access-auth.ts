import { DocumentAuth, type TDocumentAuthOptions } from '../../types/document-auth';

/**
 * Todo documento da Revalle exige o código de 6 dígitos enviado ao e-mail do destinatário na
 * conclusão. Assim um link encaminhado não conclui sem acesso à caixa de e-mail.
 */
export const withRevalleAccessAuth = (authOptions: TDocumentAuthOptions): TDocumentAuthOptions => {
  const globalAccessAuth = authOptions.globalAccessAuth ?? [];

  if (globalAccessAuth.includes(DocumentAuth.TWO_FACTOR_AUTH)) {
    return authOptions;
  }

  return { ...authOptions, globalAccessAuth: [...globalAccessAuth, DocumentAuth.TWO_FACTOR_AUTH] };
};
