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

Será testado quando o e-CNPJ chegar. Não dá para testar antes: o ITI reprova qualquer certificado fora da ICP-Brasil, como o de homologação.

Dito com franqueza: hoje o resultado não está garantido como "Aprovado". A selagem do RevSign ainda não inclui a política de assinatura ICP-Brasil (AD-RB/AD-RT) nem o controle de alterações (DocMDP), que o guia do ITI pede. Isso é trabalho da Fase 4 (spec, seção 7.2). Até lá, com o e-CNPJ real, o esperado é uma assinatura íntegra num leitor de PDF, mas o ITI pode devolver "Assinatura Indeterminada".
