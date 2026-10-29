import { NEXT_PRIVATE_USE_LEGACY_SIGNING_SUBFILTER } from '@documenso/lib/constants/app';
import { env } from '@documenso/lib/utils/env';
import type { PDF, SignOptions } from '@libpdf/core';

import { ICP_PADES_AD_RB } from './icp-policy';

const SHA256_OID = '2.16.840.1.101.3.4.2.1';

export type IcpSealEnvInput = {
  seal?: string;
  pdfDict?: string;
  policyHash?: string;
  isLegacySubFilter: boolean;
};

export type IcpSealConfig = {
  isEnabled: boolean;
  pdfDict: 'etsi' | 'pbad';
  policyHash: 'policy' | 'lpa';
};

const unknownValue = (name: string, value: string, fallback: string) =>
  `[revalle] selagem ICP: valor desconhecido em ${name} ("${value}"); usando ${fallback}`;

export const parseIcpSealEnv = ({ seal, pdfDict, policyHash, isLegacySubFilter }: IcpSealEnvInput) => {
  const warnings: string[] = [];

  if (seal && seal !== 'true' && seal !== 'false') {
    warnings.push(unknownValue('NEXT_PRIVATE_REVALLE_ICP_SEAL', seal, 'true'));
  }

  if (pdfDict && pdfDict !== 'etsi' && pdfDict !== 'pbad') {
    warnings.push(unknownValue('NEXT_PRIVATE_REVALLE_ICP_PDF_DICT', pdfDict, 'etsi'));
  }

  if (policyHash && policyHash !== 'policy' && policyHash !== 'lpa') {
    warnings.push(unknownValue('NEXT_PRIVATE_REVALLE_ICP_POLICY_HASH', policyHash, 'policy'));
  }

  const isRequested = seal !== 'false';

  // A política só existe no CAdES; o PKCS#7 legado sela como o upstream.
  if (isRequested && isLegacySubFilter) {
    warnings.push(
      '[revalle] selagem ICP desligada: NEXT_PRIVATE_USE_LEGACY_SIGNING_SUBFILTER=true (a política exige CAdES)',
    );
  }

  const config: IcpSealConfig = {
    isEnabled: isRequested && !isLegacySubFilter,
    pdfDict: pdfDict === 'pbad' ? 'pbad' : 'etsi',
    policyHash: policyHash === 'lpa' ? 'lpa' : 'policy',
  };

  return { config, warnings };
};

/**
 * A assinatura de certificação (DocMDP) tem de ser a primeira do documento: só não dá para certificar quando um
 * campo de assinatura assinado (inclusive DocTimeStamp) sobreviveu até a selagem.
 */
export const canCertifyPdf = (pdf: PDF) => {
  const signatureFields = pdf.getForm()?.getSignatureFields() ?? [];

  return !signatureFields.some((field) => field.isSigned());
};

/**
 * Opções do sign() da `@libpdf/core` com patch (patches/@libpdf+core+0.5.3.patch). Pode alterar o `pdf`: o
 * achatamento do upload e da selagem apaga as assinaturas anteriores mas deixa o /Perms delas no catálogo, apontando
 * para uma assinatura órfã; esse /Perms é removido antes de certificar.
 */
export const buildIcpSignOptions = (
  pdf: PDF,
  config: IcpSealConfig,
): { options: SignOptions['revalle']; notices: string[] } => {
  if (!config.isEnabled) {
    return { options: undefined, notices: [] };
  }

  const notices: string[] = [];
  const isCertifiable = canCertifyPdf(pdf);

  if (!isCertifiable) {
    notices.push('[revalle] selagem ICP: DocMDP omitido (o PDF já tem assinatura)');
  }

  if (isCertifiable && pdf.getCatalog().delete('Perms')) {
    notices.push('[revalle] selagem ICP: /Perms sem assinatura removido do catálogo antes de certificar');
  }

  const isPbad = config.pdfDict === 'pbad';
  const hashHex = config.policyHash === 'lpa' ? ICP_PADES_AD_RB.lpaHashHex : ICP_PADES_AD_RB.policyHashHex;

  return {
    options: {
      signaturePolicy: {
        oid: ICP_PADES_AD_RB.oid,
        hashAlgorithmOid: SHA256_OID,
        hash: Uint8Array.from(Buffer.from(hashHex, 'hex')),
        uri: ICP_PADES_AD_RB.uri,
      },
      docMdpPermissions: isCertifiable ? 2 : undefined,
      filter: isPbad ? 'PBAD_PAdES' : undefined,
      subFilter: isPbad ? 'PBAD.PAdES' : undefined,
    },
    notices,
  };
};

export const getRevalleIcpSignOptions = (pdf: PDF): SignOptions['revalle'] => {
  const { config, warnings } = parseIcpSealEnv({
    seal: env('NEXT_PRIVATE_REVALLE_ICP_SEAL'),
    pdfDict: env('NEXT_PRIVATE_REVALLE_ICP_PDF_DICT'),
    policyHash: env('NEXT_PRIVATE_REVALLE_ICP_POLICY_HASH'),
    isLegacySubFilter: NEXT_PRIVATE_USE_LEGACY_SIGNING_SUBFILTER(),
  });
  const { options, notices } = buildIcpSignOptions(pdf, config);

  for (const message of [...warnings, ...notices]) {
    console.warn(message);
  }

  return options;
};
