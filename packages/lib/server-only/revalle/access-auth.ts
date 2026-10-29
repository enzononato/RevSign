import { DocumentAuth, type TDocumentAuthOptions, type TRecipientAuthOptions } from '../../types/document-auth';

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

/**
 * A autenticação do destinatário, quando preenchida, substitui a do documento. Então ela também
 * precisa do código por e-mail, senão o remetente o desligaria por destinatário.
 */
export const withRevalleRecipientAccessAuth = (authOptions: TRecipientAuthOptions): TRecipientAuthOptions => {
  const accessAuth = authOptions.accessAuth ?? [];

  if (accessAuth.length === 0 || accessAuth.includes(DocumentAuth.TWO_FACTOR_AUTH)) {
    return authOptions;
  }

  return { ...authOptions, accessAuth: [...accessAuth, DocumentAuth.TWO_FACTOR_AUTH] };
};
