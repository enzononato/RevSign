// Selagem ICP-Brasil (Task 8, Fase 4): política PAdES AD-RB (id-aa-ets-sigPolicyId) nos atributos assinados e
// DocMDP P=2 na assinatura do RevSign. Roda contra a stack local.
// REVSIGN_ICP_SEAL_MODE diz como a stack foi subida (ver revalle/docs/testes.md):
//   etsi (padrão): NEXT_PRIVATE_REVALLE_ICP_SEAL e NEXT_PRIVATE_REVALLE_ICP_PDF_DICT sem definir;
//   pbad: NEXT_PRIVATE_REVALLE_ICP_PDF_DICT=pbad;
//   off: NEXT_PRIVATE_REVALLE_ICP_SEAL=false.
// REVSIGN_ICP_POLICY_HASH_MODE: policy (padrão, hash ETSI da política) ou lpa (NEXT_PRIVATE_REVALLE_ICP_POLICY_HASH=lpa).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';

import { BASE_URL, completeWithCode, createEnvelope, db, distribute, trpc } from './helpers.mjs';

const MODE = process.env.REVSIGN_ICP_SEAL_MODE ?? 'etsi';
const HASH_MODE = process.env.REVSIGN_ICP_POLICY_HASH_MODE ?? 'policy';
const MARIA = { cpf: '39053344705', birthDate: '07/03/1990' };
const POLICY = {
  oid: '2.16.76.1.7.1.11.1.3',
  uri: 'http://politicas.icpbrasil.gov.br/PA_PAdES_AD_RB_v1_3.der',
  hash: {
    policy: '23E4BE4B9B362172E4EBB0E72B86A133ECE5AAD843D8651C6E38A0BA3F08FC60',
    lpa: '23DA544AEF71F7A75DC85FA6E17A83875741E4BAEF41EC178258A5C86ACE54DD',
  },
};
const OTHER_HASH_MODE = HASH_MODE === 'lpa' ? 'policy' : 'lpa';
const SIG_POLICY_ID = '1.2.840.113549.1.9.16.2.15';
const SIGNING_CERTIFICATE_V2 = '1.2.840.113549.1.9.16.2.47';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// O servidor fecha conexões ociosas (keep-alive); repetir o POST num socket já fechado é seguro (ver stamp.test.mjs).
const retryOnStaleSocket = async (fn) => {
  try {
    return await fn();
  } catch (error) {
    if (!['EPIPE', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(error?.cause?.code)) {
      throw error;
    }

    return fn();
  }
};

const download = async (itemId, version) => {
  const res = await fetch(`${BASE_URL}/api/v2-beta/envelope/item/${itemId}/download?version=${version}`, {
    headers: { Authorization: `Bearer ${process.env.REVSIGN_API_TOKEN}` },
  });

  assert.equal(res.status, 200, `download ${version}`);

  return Buffer.from(await res.arrayBuffer());
};

const waitStatus = async (envelopeId, status) => {
  for (let i = 0; i < 60 && db(`select status from "Envelope" where id = '${envelopeId}'`) !== status; i += 1) {
    await sleep(2000);
  }

  return db(`select status from "Envelope" where id = '${envelopeId}'`);
};

// Envia `pdf`, conclui sem desenhar (o carimbo basta) e baixa original e final para um diretório temporário.
const sealed = async (pdf) => {
  const email = `icp-${Date.now()}-${Math.floor(Math.random() * 1e6)}@revalle.com.br`;
  const created = await retryOnStaleSocket(() => createEnvelope({ recipients: [{ email }], pdf }));

  assert.equal(created.status, 200, created.text);

  const [recipient] = await distribute(created.id);
  const documentId = Number.parseInt(created.envelope.secondaryId.split('_')[1], 10);
  const { token } = recipient;

  db('delete from "RateLimit"');
  db(`delete from "RevalleEmailLink" where cpf = '${MARIA.cpf}'`);
  await trpc('revalle.gate.acceptTerm', { token, termVersion: '1' });
  await trpc('revalle.gate.verifyIdentity', { token, ...MARIA });
  await trpc('revalle.gate.confirmIdentity', { token, isMe: true });

  const completed = await completeWithCode({ token, documentId, email });

  assert.equal(completed.status, 200, completed.text);
  assert.equal(await waitStatus(created.id, 'COMPLETED'), 'COMPLETED');

  const dir = mkdtempSync(path.join(tmpdir(), 'icp-'));
  const itemId = created.envelope.envelopeItems[0].id;

  writeFileSync(path.join(dir, 'original.pdf'), await download(itemId, 'original'));
  writeFileSync(path.join(dir, 'signed.pdf'), await download(itemId, 'signed'));

  return dir;
};

const inspect = (dir) =>
  execFileSync('sh', [path.resolve('scripts/revalle/inspect-pdf-signature.sh'), path.join(dir, 'signed.pdf')], {
    encoding: 'utf8',
  });

const verify = (dir) => {
  try {
    return {
      ok: true,
      output: execFileSync(
        'sh',
        [
          path.resolve('scripts/revalle/verify-signed-pdf.sh'),
          path.join(dir, 'signed.pdf'),
          path.join(dir, 'original.pdf'),
        ],
        { encoding: 'utf8' },
      ),
    };
  } catch (error) {
    return { ok: false, output: `${error.stdout}${error.stderr}` };
  }
};

const line = (report, key) => report.match(new RegExp(`^${key}: (.*)$`, 'm'))?.[1];

const fx = {};

before(async () => {
  fx.plain = { dir: await sealed('assets/example.pdf') };
  fx.plain.report = inspect(fx.plain.dir);
  fx.plain.verify = verify(fx.plain.dir);

  // O PDF selado acima volta como documento novo: já traz uma assinatura e /Perms /DocMDP.
  const since = new Date().toISOString();

  fx.preSigned = { dir: await sealed(path.join(fx.plain.dir, 'signed.pdf')) };
  fx.preSigned.logs = execFileSync('sh', ['-c', `docker logs --since ${since} revsign-hml-documenso-1 2>&1`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  fx.preSigned.report = inspect(fx.preSigned.dir);
  fx.preSigned.verify = verify(fx.preSigned.dir);
});

test(
  'selagem ICP: atributos assinados com a política AD-RB vigente (OID, hash SHA-256 e URI) e signingCertificateV2',
  MODE === 'off' ? { skip: 'stack com NEXT_PRIVATE_REVALLE_ICP_SEAL=false' } : {},
  () => {
    const { report } = fx.plain;

    assert.ok(report.includes(`(${SIG_POLICY_ID})`), report);
    assert.ok(report.includes(`(${SIGNING_CERTIFICATE_V2})`), report);
    assert.ok(report.includes(`:${POLICY.oid}`), report);
    assert.ok(report.includes(POLICY.hash[HASH_MODE]), `hash ${HASH_MODE} ausente:\n${report}`);
    assert.ok(!report.includes(POLICY.hash[OTHER_HASH_MODE]), `hash ${OTHER_HASH_MODE} presente:\n${report}`);
    assert.ok(report.includes(`:${POLICY.uri}`), report);
    assert.ok(report.includes(':id-smime-spq-ets-sqt-uri'), `qualificador SPuri ausente:\n${report}`);
    assert.equal(line(report, 'signedAttrs DER order'), 'OK', report);
    assert.equal(line(report, 'CMS verify \\(openssl\\)'), 'OK', report);
  },
);

test(
  'selagem ICP: DocMDP P=2 na assinatura e /Perms /DocMDP do catálogo apontando para ela',
  MODE === 'off' ? { skip: 'stack com NEXT_PRIVATE_REVALLE_ICP_SEAL=false' } : {},
  () => {
    assert.equal(line(fx.plain.report, 'DocMDP'), 'P=2', fx.plain.report);
    assert.equal(line(fx.plain.report, 'Perms/DocMDP'), 'this-signature', fx.plain.report);
  },
);

test(
  'selagem ICP (etsi): dicionário Adobe.PPKLite / ETSI.CAdES.detached e assinatura válida no pdfsig',
  MODE === 'etsi' ? {} : { skip: `stack em modo ${MODE}` },
  () => {
    assert.equal(line(fx.plain.report, 'Filter'), 'Adobe.PPKLite');
    assert.equal(line(fx.plain.report, 'SubFilter'), 'ETSI.CAdES.detached');
    assert.ok(fx.plain.verify.ok, fx.plain.verify.output);
    assert.match(fx.plain.verify.output, /Signature is Valid\./);
    assert.match(fx.plain.verify.output, /Total document signed/);
  },
);

test(
  'selagem ICP (pbad): dicionário /Filter /PBAD_PAdES /SubFilter /PBAD.PAdES, como pede a política',
  MODE === 'pbad' ? {} : { skip: `stack em modo ${MODE}` },
  () => {
    assert.equal(line(fx.plain.report, 'Filter'), 'PBAD_PAdES', fx.plain.report);
    assert.equal(line(fx.plain.report, 'SubFilter'), 'PBAD.PAdES', fx.plain.report);
  },
);

test(
  'ICP_SEAL=false: selagem do upstream, sem política, sem DocMDP e válida no pdfsig',
  MODE === 'off' ? {} : { skip: `stack em modo ${MODE}` },
  () => {
    const { report } = fx.plain;

    assert.ok(report.includes(`(${SIGNING_CERTIFICATE_V2})`), report);
    assert.ok(!report.includes(SIG_POLICY_ID), report);
    assert.ok(!report.includes(POLICY.oid), report);
    assert.equal(line(report, 'DocMDP'), 'none');
    assert.equal(line(report, 'Perms/DocMDP'), 'none');
    assert.equal(line(report, 'Filter'), 'Adobe.PPKLite');
    assert.equal(line(report, 'SubFilter'), 'ETSI.CAdES.detached');
    assert.ok(fx.plain.verify.ok, fx.plain.verify.output);
  },
);

test(
  'PDF enviado já selado: o achatamento apaga a assinatura antiga; o /Perms velho sai e a selagem nova certifica',
  MODE === 'off' ? { skip: 'stack com NEXT_PRIVATE_REVALLE_ICP_SEAL=false' } : {},
  () => {
    const { report } = fx.preSigned;

    assert.ok(report.includes(`(${SIG_POLICY_ID})`), report);
    assert.ok(report.includes(`:${POLICY.oid}`), report);
    assert.equal(line(report, 'signature'), 'Signature_1 (last of 1)', report);
    assert.equal(line(report, 'DocMDP'), 'P=2', report);
    assert.equal(line(report, 'Perms/DocMDP'), 'this-signature', report);
    assert.equal(line(report, 'signedAttrs DER order'), 'OK', report);
    assert.match(fx.preSigned.logs, /\[revalle\] selagem ICP: \/Perms sem assinatura removido do catálogo/);
    assert.doesNotMatch(fx.preSigned.logs, /DocMDP omitido/);

    if (MODE === 'etsi') {
      assert.ok(fx.preSigned.verify.ok, fx.preSigned.verify.output);
    }
  },
);
