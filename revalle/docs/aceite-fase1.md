# RevSign — roteiro de aceite da Fase 1 (homologação)

Quem faz: Enzo. Onde: `https://assinatura-hml.revalle.com.br`. Marque cada item ao concluir e anote data e observações no fim.

## Antes de começar

- [ ] As duas imagens (`revsign` e `revsign-backup`) existem no GHCR para a tag que está no ar.
- [ ] `/api/health` mostra `"status":"ok"` (banco e certificado `ok`).
- [ ] `/api/certificate-status` mostra `"isAvailable":true`.
- [ ] Conta `projetos.ti@revalle.com.br` entra no `/admin` (admin promovido após o Restart).
- [ ] Plano "Free" ajustado: membros, times e documentos sem limite (o app faz isso sozinho ao subir; confira em `/admin`, em Claims, o plano "free").
- [ ] Você tem um PDF de teste e dois e-mails de signatário que você consegue abrir (um deles no celular).

## 1. Envio em ordem (sequencial)

1. Entre no site, clique em **Enviar documento** e envie o PDF de teste.
2. Adicione dois destinatários (A e B) e marque **ordem de assinatura** (assinatura em sequência).
3. Coloque um campo de assinatura para cada um e clique em **Enviar**.

- [ ] Só A recebe o e-mail no começo; B ainda não.
- [ ] Depois que A assina, B recebe o e-mail.
- [ ] Os e-mails chegam na caixa de entrada (não no spam) e o remetente é "Revalle Assinaturas".

## 2. Envio ao mesmo tempo (paralelo)

1. Envie outro PDF de teste, com dois destinatários, **sem** ordem de assinatura.

- [ ] Os dois recebem o e-mail ao mesmo tempo.
- [ ] A ordem em que assinam não importa; o documento só conclui quando os dois assinam.

## 3. Assinar pelo celular

1. Abra o e-mail de um dos destinatários no celular, no 4G (Wi-Fi desligado).
2. Toque no link, assine com o dedo e conclua.

- [ ] A página de assinatura é usável na tela do celular.
- [ ] A assinatura é concluída e o site confirma.
- [ ] No log de auditoria do documento (abra o documento → **Logs**), o IP é o IP público do celular (confira em https://meuip.com.br no mesmo celular) e NÃO um IP interno (`10.`, `172.`, `192.168.`).
- [ ] O dispositivo/navegador aparece preenchido no log.

## 4. PDF final

1. Depois que todos assinam, aguarde a selagem (até 1 ou 2 minutos) e baixe o PDF final.

- [ ] O status do documento fica **Concluído**.
- [ ] Os destinatários recebem o e-mail com o documento concluído.
- [ ] O PDF final tem mais páginas que o original: o **certificado de assinatura** e o **log de auditoria** estão anexados no fim.
- [ ] Datas aparecem no horário da Bahia (GMT-3).

## 5. Assinatura digital válida no leitor de PDF

1. Abra o PDF final no Adobe Reader (ou outro leitor) e olhe o painel de assinaturas.

- [ ] A assinatura aparece íntegra, sem aviso de documento modificado.
- [ ] Esperado na homologação: o Adobe diz "validade desconhecida" porque o certificado é autoassinado. Se você importar o certificado como confiável, a mensagem muda. Isso não é erro.
- [ ] (Opcional, no WSL) `sh scripts/revalle/verify-signed-pdf.sh final.pdf original.pdf`: deve dizer que a assinatura está íntegra e cobre o documento inteiro, e que o final tem mais páginas.

## 6. Restauração do backup

- [ ] O serviço `revsign-backup` rodou: `backup concluido` nos logs e um arquivo `.dump.age` na pasta `revsign-backups` da hospedagem.
- [ ] `restore-test.sh latest` terminou com `RESUMO: restauração OK` (veja `backup.md`).
- [ ] A linha do teste foi anotada em "Registro de testes de restauração".

## Fora desta fase

- Verificador do ITI (validar.iti.gov.br): depende do e-CNPJ real e do trabalho da Fase 4 (spec, seção 7.2). Ver `certificado.md`.
- Armazenamento S3 dos PDFs: só na produção.

## Resultado

| Data | Quem | Resultado | Observações |
|---|---|---|---|
|  |  |  |  |
