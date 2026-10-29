#!/bin/sh
# Mostra o dicionário e os atributos assinados (CMS) da selagem de um PDF do RevSign.
#
# Uso: inspect-pdf-signature.sh <pdf> [--full]
#
# Imprime, da última assinatura do PDF que não é carimbo do tempo de documento (DocTimeStamp):
#   - Filter e SubFilter do dicionário da assinatura;
#   - DocMDP: o /P do /Reference da própria assinatura, ou "none";
#   - Perms/DocMDP: se o catálogo aponta /Perms /DocMDP para esta assinatura ("this-signature"),
#     para outra ("other") ou não tem ("none");
#   - signedAttrs DER order: atributos assinados em ordem DER (OK/FAIL);
#   - CMS verify: a assinatura CMS conferida pelo openssl sobre o ByteRange (OK/FAIL);
#   - o bloco signedAttrs de `openssl cms -cmsout -print` (com --full, a estrutura CMS inteira).
#
# Precisa de openssl e Node 24+ com as dependências do repositório instaladas (npm ci): lê o PDF
# com a @libpdf/core, a mesma biblioteca que sela.

set -eu

PDF="${1:?uso: $0 <pdf> [--full]}"
FULL="${2:-}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PDF_ABS="$(cd "$(dirname "$PDF")" && pwd)/$(basename "$PDF")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$ROOT"

node --input-type=module - "$PDF_ABS" "$TMP" <<'EOF'
import { readFileSync, writeFileSync } from 'node:fs';
import { PDF } from '@libpdf/core';
import { fromBER } from 'asn1js';

const [file, out] = process.argv.slice(2);
const pdf = await PDF.load(readFileSync(file));
const registry = pdf.context.registry;
const resolve = registry.resolve.bind(registry);
const name = (value) => value?.value ?? 'none';

const signatures = (pdf.getForm()?.getFields() ?? [])
  .filter((field) => field.type === 'signature' && field.isSigned())
  .map((field) => ({ field, dict: field.getSignatureDict(), ref: field.dict.getRef('V') }))
  .filter(({ dict }) => dict && name(dict.getName('Type')) !== 'DocTimeStamp');

if (signatures.length === 0) {
  console.error('nenhuma assinatura no PDF');
  process.exit(1);
}

const { field, dict, ref } = signatures[signatures.length - 1];
const reference = dict.getArray('Reference', resolve);
const docMdp = reference
  ? [...Array(reference.length).keys()]
      .map((index) => reference.at(index))
      .map((item) => (item?.type === 'ref' ? resolve(item) : item))
      .find((item) => name(item?.getName('TransformMethod')) === 'DocMDP')
  : undefined;
const permission = docMdp?.getDict('TransformParams', resolve)?.getNumber('P')?.value;
const permsRef = pdf.getCatalog().getDict('Perms', resolve)?.get('DocMDP');
const pointsHere =
  permsRef?.type === 'ref' && ref && permsRef.objectNumber === ref.objectNumber && permsRef.generation === ref.generation;

console.log(`signature: ${field.name} (last of ${signatures.length})`);
console.log(`Filter: ${name(dict.getName('Filter'))}`);
console.log(`SubFilter: ${name(dict.getName('SubFilter'))}`);
console.log(`DocMDP: ${docMdp ? `P=${permission}` : 'none'}`);
console.log(`Perms/DocMDP: ${permsRef ? (pointsHere ? 'this-signature' : 'other') : 'none'}`);

const contents = dict.getString('Contents').bytes;
const lengthBytes = contents[1] & 0x80 ? contents[1] & 0x7f : 0;
let length = contents[1];

if (lengthBytes) {
  length = 0;

  for (let i = 0; i < lengthBytes; i += 1) {
    length = length * 256 + contents[2 + i];
  }
}

const cms = contents.subarray(0, 2 + lengthBytes + length);

writeFileSync(`${out}/cms.der`, cms);

// DER exige o SET OF dos atributos assinados em ordem crescente de codificação. Leitores tolerantes (OpenSSL,
// pdfsig) conferem com os bytes como vieram; validadores que recodificam (BouncyCastle) reprovam fora de ordem.
const signerInfos = fromBER(cms).result.valueBlock.value[1].valueBlock.value[0].valueBlock.value.at(-1);
const signedAttrs = signerInfos.valueBlock.value[0].valueBlock.value.find(
  (item) => item.idBlock.tagClass === 3 && item.idBlock.tagNumber === 0,
);
const encodings = signedAttrs.valueBlock.value.map((attr) => Buffer.from(attr.valueBeforeDecodeView));
const isDerOrder = encodings.every((encoding, index) => index === 0 || Buffer.compare(encodings[index - 1], encoding) <= 0);

console.log(`signedAttrs DER order: ${isDerOrder ? 'OK' : 'FAIL'}`);

const bytes = readFileSync(file);
const range = dict.getArray('ByteRange');
const [start1, length1, start2, length2] = [0, 1, 2, 3].map((index) => range.at(index).value);

writeFileSync(
  `${out}/content.bin`,
  Buffer.concat([bytes.subarray(start1, start1 + length1), bytes.subarray(start2, start2 + length2)]),
);
EOF

# Só a integridade da CMS sobre o ByteRange; a cadeia do certificado não é conferida aqui.
if openssl cms -verify -inform DER -in "$TMP/cms.der" -content "$TMP/content.bin" -binary -noverify \
  -purpose any -out /dev/null 2>/dev/null; then
  echo "CMS verify (openssl): OK"
else
  echo "CMS verify (openssl): FAIL"
fi

openssl cms -inform DER -in "$TMP/cms.der" -cmsout -print > "$TMP/cms.txt"

if [ "$FULL" = "--full" ]; then
  cat "$TMP/cms.txt"
else
  echo "signedAttrs:"
  awk '/signedAttrs:/ { on = 1; next } on && /signatureAlgorithm:/ { exit } on { print }' "$TMP/cms.txt"
fi
