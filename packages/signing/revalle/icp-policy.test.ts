import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { fromBER, type ObjectIdentifier, OctetString, Sequence } from 'asn1js';
import { describe, expect, it } from 'vitest';

import { ICP_PADES_AD_RB } from './icp-policy';

const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// SignaturePolicy ::= SEQUENCE { signPolicyHashAlg, signPolicyInfo, signPolicyHash OPTIONAL } (ETSI TS 101 733 / RFC 3125).
describe('ICP_PADES_AD_RB (arquivo oficial da política em fixtures/)', () => {
  const file = new Uint8Array(readFileSync(path.join(__dirname, 'fixtures/PA_PAdES_AD_RB_v1_3.der')));
  const parsed = fromBER(file);
  const [hashAlg, info, embeddedHash] = (parsed.result as Sequence).valueBlock.value;

  it('lpaHashHex é o SHA-256 do arquivo inteiro, como a LPA publica', () => {
    expect(sha256Hex(file)).toBe(ICP_PADES_AD_RB.lpaHashHex);
  });

  it('policyHashHex é o hash ETSI (signPolicyHashAlg + signPolicyInfo) e bate com o signPolicyHash embutido', () => {
    expect(parsed.offset).toBe(file.length);
    expect(hashAlg).toBeInstanceOf(Sequence);
    expect(info).toBeInstanceOf(Sequence);
    expect(embeddedHash).toBeInstanceOf(OctetString);

    const hashed = new Uint8Array([...hashAlg.valueBeforeDecodeView, ...info.valueBeforeDecodeView]);

    expect(sha256Hex(hashed)).toBe(ICP_PADES_AD_RB.policyHashHex);
    expect(Buffer.from((embeddedHash as OctetString).valueBlock.valueHexView).toString('hex')).toBe(
      ICP_PADES_AD_RB.policyHashHex,
    );
    expect(ICP_PADES_AD_RB.policyHashHex).not.toBe(ICP_PADES_AD_RB.lpaHashHex);
  });

  it('o arquivo é a política do OID fixado e usa SHA-256', () => {
    const [policyOid] = (info as Sequence).valueBlock.value;
    const [hashAlgOid] = (hashAlg as Sequence).valueBlock.value;

    expect((policyOid as ObjectIdentifier).valueBlock.toString()).toBe(ICP_PADES_AD_RB.oid);
    expect((hashAlgOid as ObjectIdentifier).valueBlock.toString()).toBe('2.16.840.1.101.3.4.2.1');
  });
});
