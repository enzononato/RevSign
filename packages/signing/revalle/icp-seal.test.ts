import { PDF, PdfDict, PdfName } from '@libpdf/core';
import { describe, expect, it } from 'vitest';

import { ICP_PADES_AD_RB } from './icp-policy';
import { buildIcpSignOptions, canCertifyPdf, parseIcpSealEnv } from './icp-seal';

const hex = (bytes: Uint8Array | undefined) => Buffer.from(bytes ?? []).toString('hex');

const plainPdf = () => {
  const pdf = PDF.create();

  pdf.addPage();

  return pdf;
};

// Como fica um PDF já assinado depois do achatamento do upload: a assinatura sumiu, o /Perms ficou.
const stalePermsPdf = () => {
  const pdf = plainPdf();

  pdf.getCatalog().set('Perms', PdfDict.of({ DocMDP: PdfDict.of({ Type: PdfName.of('Sig') }) }));

  return pdf;
};

const signedFieldPdf = () => {
  const pdf = stalePermsPdf();

  pdf
    .getOrCreateForm()
    .createSignatureField('Assinatura_anterior')
    .getDict()
    .set('V', PdfDict.of({ Type: PdfName.of('Sig') }));

  return pdf;
};

describe('parseIcpSealEnv', () => {
  it('sem variáveis: ligado, dicionário etsi, hash da política, sem aviso', () => {
    expect(parseIcpSealEnv({ isLegacySubFilter: false })).toEqual({
      config: { isEnabled: true, pdfDict: 'etsi', policyHash: 'policy' },
      warnings: [],
    });
  });

  it('valores reconhecidos', () => {
    expect(
      parseIcpSealEnv({ seal: 'true', pdfDict: 'pbad', policyHash: 'lpa', isLegacySubFilter: false }).config,
    ).toEqual({ isEnabled: true, pdfDict: 'pbad', policyHash: 'lpa' });
    expect(parseIcpSealEnv({ seal: 'false', isLegacySubFilter: false }).config.isEnabled).toBe(false);
  });

  it('valor desconhecido: avisa nomeando a variável e mantém o padrão seguro', () => {
    const { config, warnings } = parseIcpSealEnv({
      seal: 'nao',
      pdfDict: 'PBAD',
      policyHash: 'sha256',
      isLegacySubFilter: false,
    });

    expect(config).toEqual({ isEnabled: true, pdfDict: 'etsi', policyHash: 'policy' });
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('NEXT_PRIVATE_REVALLE_ICP_SEAL');
    expect(warnings[1]).toContain('NEXT_PRIVATE_REVALLE_ICP_PDF_DICT');
    expect(warnings[2]).toContain('NEXT_PRIVATE_REVALLE_ICP_POLICY_HASH');
  });

  it('subfilter legado desliga a selagem ICP e avisa (a não ser que ela já esteja desligada)', () => {
    const legacy = parseIcpSealEnv({ isLegacySubFilter: true });

    expect(legacy.config.isEnabled).toBe(false);
    expect(legacy.warnings.join()).toContain('NEXT_PRIVATE_USE_LEGACY_SIGNING_SUBFILTER');
    expect(parseIcpSealEnv({ seal: 'false', isLegacySubFilter: true }).warnings).toEqual([]);
  });
});

describe('canCertifyPdf', () => {
  it('PDF sem assinatura e PDF só com /Perms velho podem ser certificados; com campo assinado, não', () => {
    expect(canCertifyPdf(plainPdf())).toBe(true);
    expect(canCertifyPdf(stalePermsPdf())).toBe(true);
    expect(canCertifyPdf(signedFieldPdf())).toBe(false);
  });
});

describe('buildIcpSignOptions', () => {
  const enabled = { isEnabled: true, pdfDict: 'etsi', policyHash: 'policy' } as const;

  it('desligado: nenhuma opção (selagem do upstream)', () => {
    expect(buildIcpSignOptions(plainPdf(), { ...enabled, isEnabled: false })).toEqual({
      options: undefined,
      notices: [],
    });
  });

  it('padrão: política com o hash ETSI, URI, DocMDP P=2 e dicionário do upstream', () => {
    const { options, notices } = buildIcpSignOptions(plainPdf(), enabled);

    expect(options?.signaturePolicy?.oid).toBe(ICP_PADES_AD_RB.oid);
    expect(options?.signaturePolicy?.uri).toBe(ICP_PADES_AD_RB.uri);
    expect(hex(options?.signaturePolicy?.hash)).toBe(ICP_PADES_AD_RB.policyHashHex);
    expect(options?.docMdpPermissions).toBe(2);
    expect(options?.filter).toBeUndefined();
    expect(options?.subFilter).toBeUndefined();
    expect(notices).toEqual([]);
  });

  it('lpa e pbad', () => {
    const { options } = buildIcpSignOptions(plainPdf(), { ...enabled, pdfDict: 'pbad', policyHash: 'lpa' });

    expect(hex(options?.signaturePolicy?.hash)).toBe(ICP_PADES_AD_RB.lpaHashHex);
    expect(options?.filter).toBe('PBAD_PAdES');
    expect(options?.subFilter).toBe('PBAD.PAdES');
  });

  it('/Perms velho sem assinatura: remove o /Perms, avisa e certifica com P=2', () => {
    const pdf = stalePermsPdf();
    const { options, notices } = buildIcpSignOptions(pdf, enabled);

    expect(pdf.getCatalog().has('Perms')).toBe(false);
    expect(options?.docMdpPermissions).toBe(2);
    expect(notices).toEqual(['[revalle] selagem ICP: /Perms sem assinatura removido do catálogo antes de certificar']);
  });

  it('campo assinado que sobreviveu: não certifica, mantém o /Perms e avisa; a política entra', () => {
    const pdf = signedFieldPdf();
    const { options, notices } = buildIcpSignOptions(pdf, enabled);

    expect(pdf.getCatalog().has('Perms')).toBe(true);
    expect(options?.docMdpPermissions).toBeUndefined();
    expect(options?.signaturePolicy?.oid).toBe(ICP_PADES_AD_RB.oid);
    expect(notices).toEqual(['[revalle] selagem ICP: DocMDP omitido (o PDF já tem assinatura)']);
  });
});
