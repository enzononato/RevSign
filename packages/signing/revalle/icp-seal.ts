import { NEXT_PRIVATE_USE_LEGACY_SIGNING_SUBFILTER } from '@documenso/lib/constants/app';
import { env } from '@documenso/lib/utils/env';
import type { PDF, SignOptions } from '@libpdf/core';

import { ICP_PADES_AD_RB } from './icp-policy';

const SHA256_OID = '2.16.840.1.101.3.4.2.1';

/**
 * A assinatura de certificação (DocMDP) tem de ser a primeira do documento. PDF que já traz assinatura ou /Perms
 * (ex.: PDF enviado já assinado) não pode ser certificado de novo.
 */
export const canCertifyPdf = (pdf: PDF) => {
  if (pdf.getCatalog().has('Perms')) {
    return false;
  }

  const signatureFields = pdf.getForm()?.getSignatureFields() ?? [];

  return !signatureFields.some((field) => field.isSigned());
};

/**
 * Opções do sign() da `@libpdf/core` com patch (patches/@libpdf+core+0.5.3.patch): atributo da política AD-RB
 * da ICP-Brasil e DocMDP P=2. Desligado com NEXT_PRIVATE_REVALLE_ICP_SEAL=false ou com o subfilter PKCS#7 legado
 * (a política só existe no CAdES).
 */
export const getRevalleIcpSignOptions = (pdf: PDF): SignOptions['revalle'] => {
  if (env('NEXT_PRIVATE_REVALLE_ICP_SEAL') === 'false' || NEXT_PRIVATE_USE_LEGACY_SIGNING_SUBFILTER()) {
    return undefined;
  }

  const isCertifiable = canCertifyPdf(pdf);

  if (!isCertifiable) {
    console.warn('[revalle] selagem ICP: DocMDP omitido (o PDF já tem assinatura ou /Perms)');
  }

  const isPbadDictionary = env('NEXT_PRIVATE_REVALLE_ICP_PDF_DICT') === 'pbad';

  return {
    signaturePolicy: {
      oid: ICP_PADES_AD_RB.oid,
      hashAlgorithmOid: SHA256_OID,
      hash: Uint8Array.from(Buffer.from(ICP_PADES_AD_RB.sha256Hex, 'hex')),
      uri: ICP_PADES_AD_RB.uri,
    },
    docMdpPermissions: isCertifiable ? 2 : undefined,
    filter: isPbadDictionary ? 'PBAD_PAdES' : undefined,
    subFilter: isPbadDictionary ? 'PBAD.PAdES' : undefined,
  };
};
