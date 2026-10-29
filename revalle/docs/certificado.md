# RevSign — certificado de assinatura

O RevSign sela o PDF final com um certificado digital. O certificado entra no app como duas variáveis (sem arquivo, porque não há SSH):

- `NEXT_PRIVATE_SIGNING_LOCAL_FILE_CONTENTS`: o `.p12` convertido em texto (base64), numa linha só.
- `NEXT_PRIVATE_SIGNING_PASSPHRASE`: a senha do `.p12`.

## Homologação: certificado autoassinado

Já vem pronto do script `scripts/revalle/generate-hml-secrets.sh` (passo 0 do `deploy.md`).

- O `app.env` já traz as duas variáveis preenchidas.
- Os arquivos `cert/cert.p12` e `cert/passphrase.txt` ficam no cofre de senhas.
- Validade: 365 dias.
- Limite conhecido: um certificado autoassinado não é confiável para ninguém. O Adobe mostra "validade desconhecida" (a assinatura está íntegra, só não se sabe quem é o emissor). Isso é esperado na homologação.

## Produção: e-CNPJ A1 da Revalle (para quando chegar)

### Use um A1 exclusivo para o RevSign

Por quê, em palavras simples: o certificado fica guardado num servidor ligado à internet. Se vazar, quem o tiver pode assinar qualquer coisa em nome da Revalle, inclusive nota fiscal. Com um certificado só do RevSign, basta revogá-lo e o faturamento continua funcionando.

### Passo a passo (no WSL)

1. Coloque o arquivo recebido (por exemplo `ecnpj.pfx`) numa pasta segura, fora do repositório.
2. Veja o que há dentro (pede a senha do arquivo):
   `openssl pkcs12 -info -in ecnpj.pfx -nokeys -legacy`
   Por quê `-legacy`: certificados de autoridades brasileiras costumam usar cifras antigas que o OpenSSL novo só lê assim. Confira o nome da empresa e a validade.
3. Reexporte com cifra moderna (AES-256) e com a cadeia de certificados (a raiz e as intermediárias da autoridade certificadora):
   - Extraia tudo: `openssl pkcs12 -in ecnpj.pfx -legacy -nodes -out tudo.pem`
   - Gere o novo arquivo: `openssl pkcs12 -export -in tudo.pem -out ecnpj-aes.p12 -keypbe AES-256-CBC -certpbe AES-256-CBC -macalg sha256`
   - Escolha uma senha nova e forte quando o comando pedir. Se a cadeia não vier dentro do arquivo original, baixe os certificados da AC no site dela e acrescente com `-certfile cadeia.pem`.
   - Apague `tudo.pem` logo depois (`shred -u tudo.pem`): ele guarda a chave sem senha.
4. Gere o texto base64 numa linha: `base64 -w0 ecnpj-aes.p12 > ecnpj.b64`
5. No EasyPanel, abra o serviço `revsign` → aba **Environment**.
6. Troque o valor de `NEXT_PRIVATE_SIGNING_LOCAL_FILE_CONTENTS` pelo conteúdo de `ecnpj.b64`.
7. Troque o valor de `NEXT_PRIVATE_SIGNING_PASSPHRASE` pela senha nova do passo 3.
8. Clique em **Save** e depois em **Restart**.
9. Abra `https://assinatura-hml.revalle.com.br/api/certificate-status` (ou o domínio da produção). Esperado: `"isAvailable":true`.
10. Envie e assine um documento de teste. Baixe o PDF final e confira a assinatura (veja `aceite-fase1.md`).
11. Guarde o `.p12`, a senha e a data de validade no cofre de senhas. Apague `ecnpj.b64` e as cópias soltas.

### Renovação

O A1 vale 1 ano. Crie agora um lembrete na agenda para 30 dias antes do vencimento: "Renovar e-CNPJ A1 do RevSign". A renovação repete os passos acima. Se o certificado vencer, as novas assinaturas falham.

### Verificador do ITI (validar.iti.gov.br)

Será testado quando o e-CNPJ chegar. Não dá para testar antes: o ITI reprova qualquer certificado fora da ICP-Brasil, como o de homologação. Este é o aceite final da selagem (spec, seção 7.2).

## Selagem ICP-Brasil (política AD-RB e DocMDP)

Desde a Fase 4, a assinatura que o RevSign põe no PDF final segue a política **PAdES AD-RB** da ICP-Brasil:

- **Política de assinatura** nos atributos assinados (`id-aa-ets-sigPolicyId`): OID `2.16.76.1.7.1.11.1.3` (AD-RB v1.3), SHA-256 do arquivo da política e o endereço dele (`http://politicas.icpbrasil.gov.br/PA_PAdES_AD_RB_v1_3.der`). Os valores ficam em `packages/signing/revalle/icp-policy.ts`, tirados da lista oficial (LPA) em 29/10/2026. A política vale de 23/07/2025 a 22/10/2037.
- Os demais atributos que a política exige já vinham do upstream: `contentType`, `messageDigest` e `signingCertificateV2`. Não há carimbo do tempo (AD-RB não exige).
- **DocMDP P=2** (assinatura de certificação): depois da selagem, só são permitidos preencher formulário, assinar e acrescentar dados de validação/carimbo do tempo. Qualquer outra mudança no PDF aparece como violação no leitor.
- Se o PDF enviado já tiver assinatura ou `/Perms` (por exemplo, um PDF que já veio assinado), o DocMDP é omitido: a certificação precisa ser a primeira assinatura do documento. A política entra do mesmo jeito, e o log do app registra `[revalle] selagem ICP: DocMDP omitido`.
- Com carimbo do tempo configurado (`NEXT_PRIVATE_SIGNING_TIMESTAMP_AUTHORITY`), o upstream acrescenta DSS e carimbo do tempo de documento depois da assinatura; o P=2 permite isso. Hoje a homologação não usa carimbo do tempo.

Variáveis (ver `deploy.md`):

| Variável | Padrão | Efeito |
|---|---|---|
| `NEXT_PRIVATE_REVALLE_ICP_SEAL` | `true` | `false` volta à selagem do upstream (sem política e sem DocMDP) |
| `NEXT_PRIVATE_REVALLE_ICP_PDF_DICT` | `etsi` | `etsi`: `/Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached`. `pbad`: `/Filter /PBAD_PAdES /SubFilter /PBAD.PAdES` |

### Por que `etsi` é o padrão

A política lista `Filter = PBAD_PAdES` e `SubFilter = PBAD.PAdES` no dicionário da assinatura. Mas o Adobe, o Foxit e o pdfsig só reconhecem `Adobe.PPKLite` / `ETSI.CAdES.detached`, que é também o que o assinador do próprio ITI produz. A expectativa é que o validar.iti.gov.br aceite esse dicionário, mas só o teste com o e-CNPJ confirma. O conteúdo assinado (CMS) é o mesmo nos dois modos; só muda o nome no dicionário.

### Como validar quando o e-CNPJ chegar

1. Instale o e-CNPJ (passo a passo acima) e reinicie o app.
2. Envie um documento de teste, assine e baixe o PDF final.
3. Confira localmente: `sh scripts/revalle/inspect-pdf-signature.sh final.pdf`. Esperado: `DocMDP: P=2`, `Perms/DocMDP: this-signature`, `signedAttrs DER order: OK`, `CMS verify (openssl): OK` e, em `signedAttrs`, `id-smime-aa-ets-sigPolicyId` com `2.16.76.1.7.1.11.1.3`. Depois `sh scripts/revalle/verify-signed-pdf.sh final.pdf`.
4. Abra https://validar.iti.gov.br, envie o PDF final e leia o relatório.

O que cada resultado significa:

| Resultado no ITI | Significado | O que fazer |
|---|---|---|
| **Aprovado** (assinatura válida, política AD-RB reconhecida) | Aceite da spec 7.2 cumprido | Guardar o relatório (PDF) junto do aceite |
| **Reprovado/Indeterminado** por causa do dicionário (Filter/SubFilter fora da política) | O ITI exige os nomes da política | Definir `NEXT_PRIVATE_REVALLE_ICP_PDF_DICT=pbad`, reiniciar, assinar outro documento e reenviar ao ITI. Troca de variável, sem mudança de código |
| **Indeterminado** por cadeia de certificados ou revogação | O `.p12` não traz a cadeia completa da AC, ou o ITI não alcançou a LCR | Refazer o passo 3 da instalação com `-certfile cadeia.pem` |
| **Reprovado** por política desconhecida ou hash diferente | A LPA mudou (versão nova da AD-RB) | Atualizar `icp-policy.ts` (ver "Política nova" abaixo) |
| **Reprovado** por "modificação após assinatura" | Algo alterou o PDF depois da selagem | Conferir com `verify-signed-pdf.sh`; abrir chamado com o PDF |

Custo do modo `pbad`: o Adobe passa a mostrar "manipulador de assinatura desconhecido" (não sabe validar `PBAD.PAdES`) e o pdfsig não confere a assinatura. Por isso ele só deve ser ligado se o ITI reprovar o modo `etsi`.

### Política nova na LPA

A LPA (`http://politicas.icpbrasil.gov.br/LPA_PAdES.der`) é republicada periodicamente (a lida em 29/10/2026 tem próxima atualização em 01/01/2027). Para conferir:

1. `curl -sO http://politicas.icpbrasil.gov.br/LPA_PAdES.der && openssl asn1parse -inform DER -in LPA_PAdES.der`
2. Procure o OID `2.16.76.1.7.1.11.1.x` mais alto que não esteja revogado, com o período de validade cobrindo hoje. Ao lado estão o endereço do `.der` e o SHA-256.
3. Baixe o `.der` da política e confira: `sha256sum PA_PAdES_AD_RB_v1_x.der` tem de bater com o valor da LPA.
4. Atualize `oid`, `uri`, `sha256Hex` e `retrievedAt` em `packages/signing/revalle/icp-policy.ts`, e o OID em `scripts/revalle/tests/icp-seal.test.mjs`.

### Atualização da `@libpdf/core` (patch)

A política e o DocMDP entram por um patch na biblioteca de PDF: `patches/@libpdf+core+0.5.3.patch`, aplicado sozinho pelo `npm ci` (script `postinstall: patch-package`) no computador e nas duas etapas do `docker/Dockerfile`. Ele mexe em 4 pontos de `dist/index.mjs` (marcados com `REVALLE:`) e no tipo `SignOptions` de `dist/index.d.mts`:

1. import de `IA5String` do `asn1js`;
2. função `revalleAddSignaturePolicy` (atributo `1.2.840.113549.1.9.16.2.15` + ordenação DER dos atributos), chamada em `CAdESDetachedBuilder.create` logo depois de `buildSignedAttributes`;
3. em `PDFSignature.sign()`, depois de montar `signatureDict`: `/Filter` e `/SubFilter` literais (modo `pbad`), `/Reference` DocMDP e, depois do `register`, o `/Perms /DocMDP` do catálogo;
4. `revalleSignaturePolicy` repassado ao `create()` do formato.

Ao atualizar a `@libpdf/core`:

1. Antes de subir a versão, leia o changelog: se a biblioteca passou a aceitar política de assinatura e DocMDP nativamente, troque o patch pelas opções dela e apague o arquivo do patch.
2. Suba a versão (`npm install @libpdf/core@x.y.z`). O `patch-package` avisa se o patch não aplicar.
3. Refaça as 4 mudanças acima em `node_modules/@libpdf/core/dist/` (procure `buildSignedAttributes`, `const signatureDict = PdfDict.of` e `getFormatBuilder(resolved.subFilter).create`) e gere o patch novo: `npx patch-package @libpdf/core`. Apague o patch da versão antiga.
4. `cd packages/signing && npx tsc --noEmit`, reconstrua a imagem e rode `scripts/revalle/tests/icp-seal.test.mjs` (ver `testes.md`) nos três modos.
