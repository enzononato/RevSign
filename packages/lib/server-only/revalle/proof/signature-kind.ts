export type SignatureKind = 'IMAGE' | 'TYPED' | 'NONE';

type SignatureLike = { signatureImageAsBase64?: string | null; typedSignature?: string | null } | null | undefined;

/** Imagem (desenhada ou enviada, indistinguíveis) vale mais que texto digitado; sem nenhuma, NONE. */
export const classifySignature = (signatures: SignatureLike[]): SignatureKind => {
  if (signatures.some((signature) => Boolean(signature?.signatureImageAsBase64))) {
    return 'IMAGE';
  }

  if (signatures.some((signature) => Boolean(signature?.typedSignature?.trim()))) {
    return 'TYPED';
  }

  return 'NONE';
};
