export type IcpSignaturePolicy = {
  oid: string;
  uri: string;
  sha256Hex: string;
  source: string;
  retrievedAt: `${number}-${number}-${number}`;
};

/**
 * Política PAdES AD-RB vigente na LPA oficial da ICP-Brasil.
 *
 * Fonte: http://politicas.icpbrasil.gov.br/LPA_PAdES.der, lida em 2026-10-29 (próxima LPA: 2027-01-01).
 * Validade da política: 2025-07-23 a 2037-10-22. A v1.2 (2.16.76.1.7.1.11.1.2) foi revogada em 2025-07-23;
 * v1.0/v1.1 seguem válidas até 2029-03-02, mas foram substituídas.
 * O SHA-256 é o do arquivo `.der` da política, igual ao que a LPA publica (conferido nos dois).
 * Ao trocar de versão: baixe a LPA, decodifique (`openssl asn1parse -inform DER`), pegue a AD-RB vigente
 * e confira o SHA-256 do `.der` dela (ver revalle/docs/certificado.md).
 */
export const ICP_PADES_AD_RB: IcpSignaturePolicy = {
  oid: '2.16.76.1.7.1.11.1.3',
  uri: 'http://politicas.icpbrasil.gov.br/PA_PAdES_AD_RB_v1_3.der',
  sha256Hex: '23da544aef71f7a75dc85fa6e17a83875741e4baef41ec178258a5c86ace54dd',
  source: 'http://politicas.icpbrasil.gov.br/LPA_PAdES.der',
  retrievedAt: '2026-10-29',
};
