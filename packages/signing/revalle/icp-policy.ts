export type IcpSignaturePolicy = {
  oid: string;
  uri: string;
  /** SHA-256 de DER(signPolicyHashAlg) || DER(signPolicyInfo): o signPolicyHash ETSI embutido no próprio arquivo. */
  policyHashHex: string;
  /** SHA-256 do arquivo `.der` inteiro, o valor que a LPA publica. */
  lpaHashHex: string;
  source: string;
  retrievedAt: `${number}-${number}-${number}`;
};

/**
 * Política PAdES AD-RB vigente na LPA oficial da ICP-Brasil.
 *
 * Fonte: http://politicas.icpbrasil.gov.br/LPA_PAdES.der, lida em 2026-10-29 (próxima LPA: 2027-01-01).
 * Validade da política: 2025-07-23 a 2037-10-22. A v1.2 (2.16.76.1.7.1.11.1.2) foi revogada em 2025-07-23;
 * v1.0/v1.1 seguem válidas até 2029-03-02, mas foram substituídas.
 *
 * Dois hashes possíveis no sigPolicyHash (NEXT_PRIVATE_REVALLE_ICP_POLICY_HASH): o ETSI TS 101 733 (padrão, o que o
 * Demoiselle compara via getSignPolicyHash) e o da LPA. O arquivo oficial está em fixtures/ e o teste confere os dois.
 * Ao trocar de versão, ver revalle/docs/certificado.md ("Política nova na LPA").
 */
export const ICP_PADES_AD_RB: IcpSignaturePolicy = {
  oid: '2.16.76.1.7.1.11.1.3',
  uri: 'http://politicas.icpbrasil.gov.br/PA_PAdES_AD_RB_v1_3.der',
  policyHashHex: '23e4be4b9b362172e4ebb0e72b86a133ece5aad843d8651c6e38a0ba3f08fc60',
  lpaHashHex: '23da544aef71f7a75dc85fa6e17a83875741e4baef41ec178258a5c86ace54dd',
  source: 'http://politicas.icpbrasil.gov.br/LPA_PAdES.der',
  retrievedAt: '2026-10-29',
};
