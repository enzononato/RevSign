# Integração Patrimônio → RevSign (termos de responsabilidade de equipamento)

Contrato para quem desenvolve o Patrimônio. O Patrimônio manda o termo (PDF) e os dados do colaborador; o RevSign envia o
link por e-mail, confere a identidade (CPF + data de nascimento na base do RH + código de 6 dígitos por e-mail), sela o
PDF (carimbo, certificado, `/verificar`) e avisa o Patrimônio a cada mudança de estado.

- Base: `https://assinatura.revalle.com.br/api/revalle/patrimonio/v1` (ou o endereço interno, seção 11).
- Tudo em JSON UTF-8, menos a criação (multipart) e o download (PDF).
- `termoId` é o id do documento no RevSign (`envelope_…`). Guarde-o junto do seu registro.

## 1. Autenticação

Todo pedido leva `Authorization: Bearer <chave>`. A chave é única (a mesma `NEXT_PRIVATE_REVALLE_PATRIMONIO_API_KEY` do
RevSign, 32+ caracteres, gerada com `openssl rand -hex 32`) e fica só no servidor do Patrimônio, nunca no navegador.
Chave ausente ou errada: `401 UNAUTHORIZED`. Integração desligada no RevSign: `404 NOT_CONFIGURED` em todas as rotas.
Limite: 120 pedidos por minuto por IP (`429 RATE_LIMITED`, com `Retry-After`).

## 2. Criar e enviar um termo

`POST /termos`, `multipart/form-data`:

| Campo | Obrigatório | Regra |
|---|---|---|
| `file` | sim | PDF, até 10 MB, começando com `%PDF-`, sem senha |
| `externalId` | sim | seu id do termo: até 120 caracteres de `A-Z a-z 0-9 . _ : -` |
| `kind` | sim | `ENTREGA` ou `DEVOLUCAO` |
| `title` | sim | título do documento (aparece no e-mail e no PDF), até 200 caracteres |
| `signerName` | sim | nome do colaborador, até 255 caracteres |
| `signerEmail` | sim | e-mail do colaborador; **pode ser pessoal** (só nesta integração) |
| `signerCpf` | sim | CPF, com ou sem pontuação; tem de ser válido e estar na base do RH |
| `message` | não | texto do e-mail de convite, até 2000 caracteres |

Resposta `201` (o mesmo formato de `GET /termos/{termoId}`):

```json
{
  "termoId": "envelope_abcdefghijklmnop",
  "externalId": "PAT-2026-000123",
  "kind": "ENTREGA",
  "title": "Termo de entrega - Notebook 000123",
  "status": "PENDING",
  "createdAt": "2026-11-12T13:00:00.000Z",
  "completedAt": null,
  "cancelledAt": null,
  "cancelReason": null,
  "signer": { "name": "Fulano de Tal", "email": "fulano@gmail.com", "signedAt": null, "expiresAt": null, "rejectionReason": null }
}
```

Nunca há dois termos `PENDING` com o mesmo `externalId`: a segunda criação responde `409 DUPLICATE_EXTERNAL_ID` com o
`termoId` existente (`{"error": {"code": "DUPLICATE_EXTERNAL_ID", "message": "…", "termoId": "envelope_…"}}`). Por isso,
depois de uma falha de rede, repita a criação sem medo: ou cria, ou devolve o termo que já existe. Termo cancelado,
recusado, assinado ou vencido libera o `externalId`. Trocar o equipamento antes da assinatura = cancelar e criar outro.

**Arquivo.** O RevSign só aceita PDF. Converta o `.docx` do seu lado com o LibreOffice:

```sh
soffice --headless --convert-to pdf --outdir /tmp/termos /tmp/termos/termo-000123.docx
```

## 3. Onde vai a assinatura: o marcador `{{assinatura}}`

No modelo Word, escreva `{{assinatura}}` onde o colaborador assina. O RevSign acha o marcador no PDF, cobre o texto de
branco e cria um campo de assinatura de **180 × 54 pt (6,35 × 1,9 cm)** com o canto superior esquerdo no início do
marcador (se não couber, o campo é empurrado para dentro da página). Mais de um marcador = mais de um campo, todos do
mesmo colaborador. Sem marcador: `422 MARKER_NOT_FOUND`.

Dicas para o modelo:

- Maiúsculas e minúsculas não importam, e espaços dentro das chaves são aceitos (`{{ Assinatura }}`). Qualquer fonte e
  cor (pode ser branca, para não aparecer na impressão do modelo).
- Deixe livre um espaço de uns 6,5 cm à direita e 2 cm abaixo do início do marcador: o campo cobre essa área.
- O marcador tem de ficar inteiro numa linha e ser texto de verdade (não imagem, não WordArt, não caixa de texto girada).
- Página em retrato ou paisagem pelo tamanho do papel, sem girar a página.
- Confira o PDF convertido: `pdftotext termo.pdf - | grep -i assinatura` tem de mostrar o marcador.

## 4. Estados

| `status` | Quando |
|---|---|
| `PENDING` | enviado, aguardando o colaborador (também depois de assinar, até a selagem terminar, alguns segundos) |
| `SIGNED` | assinado e selado: o PDF final está pronto |
| `REJECTED` | o colaborador recusou (`signer.rejectionReason` traz o motivo) |
| `EXPIRED` | o prazo do link venceu sem assinatura |
| `CANCELLED` | cancelado pelo Patrimônio (ou pela tela do RevSign) |

## 5. Avisos (webhook)

A cada mudança de estado o RevSign faz `POST` no endereço configurado (`NEXT_PRIVATE_REVALLE_PATRIMONIO_WEBHOOK_URL`):

| Evento | Estado |
|---|---|
| `termo.sent` | `PENDING` (enviado ao colaborador) |
| `termo.signed` | `SIGNED` (concluído e selado; o PDF já pode ser baixado) |
| `termo.rejected` | `REJECTED` |
| `termo.expired` | `EXPIRED` |
| `termo.cancelled` | `CANCELLED` |

Corpo (pequeno: sem CPF, sem links de assinatura):

```json
{
  "eventId": "evt_3f2a…",
  "event": "termo.signed",
  "termoId": "envelope_abcdefghijklmnop",
  "externalId": "PAT-2026-000123",
  "status": "SIGNED",
  "occurredAt": "2026-11-12T13:05:10.123Z",
  "signer": { "name": "Fulano de Tal", "email": "fulano@gmail.com" }
}
```

`rejectionReason` vem a mais só em `termo.rejected`. Cabeçalhos: `X-RevSign-Event`, `X-RevSign-Event-Id`,
`X-RevSign-Timestamp` (segundos Unix) e `X-RevSign-Signature: sha256=<hex>`, o HMAC-SHA256 com o segredo
(`NEXT_PRIVATE_REVALLE_PATRIMONIO_WEBHOOK_SECRET`) de `timestamp + "." + corpo bruto`.

Conferência no FastAPI (use o **corpo bruto**, antes de qualquer parse):

```python
import hashlib, hmac, os, time
from fastapi import FastAPI, HTTPException, Request

app = FastAPI()
SECRET = os.environ["REVSIGN_WEBHOOK_SECRET"].encode()

@app.post("/revsign/webhook")
async def revsign_webhook(request: Request):
    raw = await request.body()
    timestamp = request.headers.get("X-RevSign-Timestamp", "")
    signature = request.headers.get("X-RevSign-Signature", "")
    expected = "sha256=" + hmac.new(SECRET, timestamp.encode() + b"." + raw, hashlib.sha256).hexdigest()
    if not timestamp.isdigit() or abs(time.time() - int(timestamp)) > 300 or not hmac.compare_digest(expected, signature):
        raise HTTPException(status_code=401)
    event = await request.json()
    # Idempotência: se event["eventId"] já foi processado, responda 200 e não faça nada.
    # Processe rápido (ou enfileire) e responda 2xx.
    return {"ok": True}
```

Entrega e repetição:

- Resposta **2xx** = entregue. Qualquer outra coisa (ou 10 s sem resposta) = falha.
- Até **5 tentativas**: na hora, depois de 30 s, 2 min, 10 min e 1 h. Se o RevSign reiniciar no meio da espera, a
  tentativa sai na varredura seguinte (a cada 15 min).
- O **mesmo aviso pode chegar mais de uma vez** (mesmo `eventId`, mesmo corpo): guarde os `eventId` processados e
  ignore a repetição. A ordem não é garantida entre tentativas; use o `status` e, na dúvida, consulte
  `GET /termos/{termoId}`.
- Redirecionamento não é seguido. Depois da 5ª falha o aviso desiste (fica registrado no RevSign); reconcilie pelo
  `GET` de estado.

## 6. Baixar o PDF assinado

`GET /termos/{termoId}/pdf` devolve o PDF final selado (carimbo da assinatura, certificado e assinatura digital do
RevSign; o mesmo que o RevSign entrega na tela). Só para `SIGNED`; senão `409 NOT_SIGNED`. O cabeçalho
`X-RevSign-SHA256` traz o SHA-256 do arquivo, o mesmo mostrado em `https://assinatura.revalle.com.br/verificar`.
Guarde o arquivo do seu lado.

## 7. Consultar, buscar, cancelar e reenviar

| Método | Caminho | Faz |
|---|---|---|
| GET | `/termos/{termoId}` | estado do termo (formato da seção 2) |
| GET | `/termos?externalId=PAT-2026-000123` | `{"data": [...]}`: termos com esse `externalId`, mais novo primeiro (até 50) |
| POST | `/termos/{termoId}/cancelar` | corpo opcional `{"reason": "texto até 500 caracteres"}`; só `PENDING` (senão `409 NOT_PENDING`). O link para de funcionar, o colaborador recebe o aviso de cancelamento com o motivo e a trilha de auditoria fica |
| POST | `/termos/{termoId}/reenviar` | manda de novo o e-mail com o link; só `PENDING`; no máximo 1 vez a cada 10 minutos por termo (`429 RESEND_TOO_SOON`, com `Retry-After`) |

## 8. Erros

Formato: `{"error": {"code": "…", "message": "…"}}` (às vezes com um campo a mais, como `termoId` ou `status`).

| Código | HTTP | Quando |
|---|---|---|
| `UNAUTHORIZED` | 401 | chave ausente ou errada |
| `NOT_CONFIGURED` | 404 | integração desligada no RevSign (sem chave ou sem conta remetente) |
| `NOT_FOUND` | 404 | termo não existe |
| `INVALID_REQUEST` | 400 | campo faltando ou fora da regra, multipart malformado, corpo que não é JSON |
| `METHOD_NOT_ALLOWED` | 405 | método errado para a rota |
| `INVALID_FILE` | 422 | não é PDF, PDF corrompido ou com senha |
| `FILE_TOO_LARGE` | 413 | arquivo acima de 10 MB |
| `MARKER_NOT_FOUND` | 422 | o PDF não tem `{{assinatura}}` |
| `INVALID_CPF` | 422 | CPF inválido |
| `COLABORADOR_NOT_FOUND` | 422 | CPF válido que não está na base do RH |
| `HR_BASE_UNAVAILABLE` | 503 | base do RH fora do ar; tente de novo depois |
| `DUPLICATE_EXTERNAL_ID` | 409 | já existe termo `PENDING` com esse `externalId` (vem o `termoId`) |
| `NOT_PENDING` | 409 | cancelar ou reenviar termo que não está `PENDING` |
| `NOT_SIGNED` | 409 | PDF de termo que não está `SIGNED` |
| `RESEND_TOO_SOON` | 429 | reenvio a menos de 10 minutos do anterior |
| `RATE_LIMITED` | 429 | limite de pedidos por IP |
| `INTERNAL_ERROR` | 500 | erro inesperado; repita (a criação é segura para repetir) |

## 9. Variáveis do Patrimônio (só os nomes)

- `REVSIGN_PATRIMONIO_BASE_URL` (ex.: `https://assinatura.revalle.com.br/api/revalle/patrimonio/v1`)
- `REVSIGN_PATRIMONIO_API_KEY`
- `REVSIGN_WEBHOOK_SECRET`

## 10. O que o colaborador vê

E-mail "Você tem um novo documento para assinar" com o link. Ao abrir: termo de assinatura eletrônica, **CPF e data de
nascimento sempre** (só o CPF informado pelo Patrimônio passa; 5 erros bloqueiam o link), confirmação do nome, a
assinatura no campo e o código de 6 dígitos enviado ao mesmo e-mail. O e-mail pessoal não vira credencial para outros
documentos do RevSign. Ao concluir, o colaborador recebe o PDF assinado por e-mail.

## 11. Configuração no EasyPanel (RevSign)

1. **Conta remetente.** Crie no RevSign um usuário para a integração (ex.: `patrimonio@revalle.com.br`, cadastro normal
   com e-mail confirmado). Os termos ficam no time pessoal dele e é o nome dele que aparece como remetente; o admin vê os
   termos normalmente. Se a conta for desativada, a integração responde `404 NOT_CONFIGURED`.
2. **Variáveis do app** (Environment do serviço do RevSign) e **Deploy**:

   | Variável | Valor |
   |---|---|
   | `NEXT_PRIVATE_REVALLE_PATRIMONIO_API_KEY` | `openssl rand -hex 32` (a mesma chave vai para o Patrimônio) |
   | `NEXT_PRIVATE_REVALLE_PATRIMONIO_SENDER_EMAIL` | e-mail da conta do passo 1 |
   | `NEXT_PRIVATE_REVALLE_PATRIMONIO_WEBHOOK_URL` | endereço do webhook do Patrimônio (abaixo) |
   | `NEXT_PRIVATE_REVALLE_PATRIMONIO_WEBHOOK_SECRET` | `openssl rand -hex 32` (o mesmo vai para o Patrimônio) |
   | `NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS` | só com endereço interno: o nome do host interno do Patrimônio |

3. **Endereço interno ou público.**
   - Interno (recomendado quando os dois estão no mesmo projeto do EasyPanel): não sai da VPS e não depende do DNS nem do
     certificado. O Patrimônio chama `http://<serviço-interno-do-revsign>:3000/api/revalle/patrimonio/v1` e o webhook
     aponta para `http://<serviço-interno-do-patrimonio>:<porta>/<caminho>` (o EasyPanel mostra o nome interno de cada
     serviço, ex.: `revalle_patrimonio-api`). Como esse nome resolve para um IP privado, o RevSign só o chama se ele
     estiver em `NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS` (o nome exato, sem porta nem `http://`; vários separados por
     vírgula). Atenção: a liberação vale também para os webhooks de time do RevSign; libere só esse host.
   - Público: `https://…` dos dois lados. Não precisa da liberação de SSRF, mas o tráfego passa pelo proxy e depende do
     DNS e do certificado.
4. Sem `NEXT_PRIVATE_REVALLE_PATRIMONIO_API_KEY` a integração fica desligada (404). Sem URL ou segredo do webhook, as
   rotas funcionam e nenhum aviso é enviado.

## 12. Testar em homologação

1. No EasyPanel da homologação, faça a seção 11 apontando o webhook para um receptor de teste. Receptor mínimo (Python 3,
   sem dependências), que mostra cada aviso e se o HMAC confere:

   ```python
   # receptor.py — uso: REVSIGN_WEBHOOK_SECRET=... python3 receptor.py
   import hashlib, hmac, os
   from http.server import BaseHTTPRequestHandler, HTTPServer

   SECRET = os.environ["REVSIGN_WEBHOOK_SECRET"].encode()

   class Handler(BaseHTTPRequestHandler):
       def do_POST(self):
           raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
           ts = self.headers.get("X-RevSign-Timestamp", "")
           expected = "sha256=" + hmac.new(SECRET, ts.encode() + b"." + raw, hashlib.sha256).hexdigest()
           ok = hmac.compare_digest(expected, self.headers.get("X-RevSign-Signature", ""))
           print("HMAC", "ok" if ok else "ERRADO", raw.decode(), flush=True)
           self.send_response(200 if ok else 401)
           self.end_headers()

   HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
   ```

2. Gere o PDF de teste a partir do modelo com `{{assinatura}}` (seção 2) e crie o termo (CPF de alguém da base de
   homologação; e-mail seu):

   ```sh
   export BASE=https://assinatura-hml.revalle.com.br/api/revalle/patrimonio/v1 KEY=...   # a chave da homologação
   curl -sS -X POST "$BASE/termos" -H "Authorization: Bearer $KEY" \
     -F file=@termo.pdf -F externalId=HML-TESTE-1 -F kind=ENTREGA -F "title=Termo de teste" \
     -F "signerName=Seu Nome" -F signerEmail=seu.email@gmail.com -F signerCpf=00000000000
   ```

   Esperado: `201` com o `termoId`, o e-mail com o link e o aviso `termo.sent` no receptor (`HMAC ok`).
3. Repita o mesmo comando: `409 DUPLICATE_EXTERNAL_ID` com o mesmo `termoId`.
4. Abra o link do e-mail, faça o portão (CPF e data de nascimento da pessoa da base), assine e digite o código. Em
   alguns segundos chega `termo.signed`. Então:

   ```sh
   curl -sS "$BASE/termos/<termoId>" -H "Authorization: Bearer $KEY"                    # "status": "SIGNED"
   curl -sS -D - -o termo-assinado.pdf "$BASE/termos/<termoId>/pdf" -H "Authorization: Bearer $KEY"
   sha256sum termo-assinado.pdf                                                         # = X-RevSign-SHA256
   ```

   Confira o SHA-256 em `/verificar` com o código de verificação do carimbo.
5. Cancelamento e reenvio: crie `HML-TESTE-2`, chame `POST $BASE/termos/<termoId>/reenviar` (200; chamar de novo dá
   `429`), depois `POST $BASE/termos/<termoId>/cancelar -H 'Content-Type: application/json' -d '{"reason":"teste"}'`
   (chega `termo.cancelled`; o link do e-mail para de funcionar).
6. Recusa: crie `HML-TESTE-3`, abra o link e recuse com um motivo: chega `termo.rejected` com `rejectionReason`.
7. Erros: sem `-H Authorization` (401), PDF sem o marcador (422 `MARKER_NOT_FOUND`), CPF fora da base
   (422 `COLABORADOR_NOT_FOUND`).
