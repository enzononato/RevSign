# Contrato para colaboradores (v.21)

Para quem: administradores do RevSign. Serve quando a empresa tem **um contrato que todos os colaboradores precisam
assinar**. O representante da empresa assina uma vez; depois cada colaborador recebe por e-mail o seu próprio documento,
já com a assinatura do representante, e assina **sem precisar de conta**.

Só o administrador do sistema vê e usa tudo isto.

## Passo a passo

1. **O representante assina.** Crie um documento comum com o contrato, ponha o representante como signatário e envie.
   Funciona como qualquer documento: o representante passa pelas regras de sempre (conta, CPF e código por e-mail).
2. **Use o documento concluído como contrato.** Quando o documento estiver **concluído** (todas as assinaturas feitas),
   aparece o botão **Usar como contrato para colaboradores**.
   - Cada documento vira no máximo **um** contrato. Se clicar de novo, o sistema abre o contrato que já existe.
   - O botão cria um **modelo** com as páginas do contrato assinado, com a assinatura do representante, **sem as
     páginas de certificado e de auditoria** do envio dele. O modelo tem um signatário genérico ("Colaborador").
3. **Posicione a assinatura do colaborador.** Abra o modelo no editor e coloque o campo de assinatura do colaborador em
   cada arquivo. **Sem esse campo o envio é recusado.**
4. **Envie pela planilha.** No modelo, use o envio em massa por planilha (CSV) com as colunas:

   ```
   recipient_1_email,recipient_1_name
   ```

   - O nome é opcional.
   - Até **3.000 linhas** por planilha.
   - E-mail repetido na planilha é **pulado** (e contado no resumo).
   - Só **uma planilha por vez**: enquanto uma estiver sendo processada, uma segunda é recusada.
5. **Acompanhe.** Os documentos não saem na hora: entram numa **fila**. Veja a seção "Como o envio acontece".

## Como o envio acontece

- Uma tarefa automática roda **a cada 15 minutos** e envia uma parte da fila.
- Cada rodada envia `NEXT_PRIVATE_REVALLE_BULK_SEND_PER_HOUR` dividido por 4. O padrão é **100 por hora**, ou seja,
  **25 a cada 15 minutos**. Para 1.200 colaboradores no padrão, são cerca de 12 horas.
- Cada colaborador recebe o convite normal (assunto automático) e, ao assinar, a cópia assinada.
- Se um documento falhar, o sistema tenta de novo. Depois de **3 tentativas** ele fica como "falhou", com o motivo
  (sem dado pessoal), e **a fila continua** para os outros.

O ritmo deve respeitar o limite de envio do SMTP do cPanel. Veja `deploy.md`.

## O quadro "Envio para colaboradores"

Na página do modelo marcado aparece o quadro com:

- total da planilha, na fila, enviados, falharam (com o motivo), visualizados, assinados e recusados;
- **Baixar planilha da situação**: arquivo com `nome;e-mail;situação;data`;
- **Pausar** e **Retomar** o envio (a fila para e volta de onde parou).

## Como o colaborador assina

- **Não precisa de conta** nesses contratos, mesmo com e-mail da empresa. Quem já tem conta entra normalmente.
- O sistema **sempre pede CPF e data de nascimento**, mesmo que a pessoa já tenha assinado antes. A pessoa precisa estar
  na base do RH, com as conferências de sempre.
- O código de 6 dígitos por e-mail, o termo e o carimbo continuam como em qualquer documento.
- O certificado e a página `/verificar` do colaborador trazem a linha **"Assinado pela empresa: {representante} em
  {data}, código {código}"**, com link para a verificação do documento do representante.

## O que fica protegido

- Só administrador do sistema pode **editar, duplicar ou salvar como modelo** os documentos que estão na fila e o
  modelo marcado. O **link direto** do modelo é recusado.
- Documento que **falhou** (depois das 3 tentativas) e documentos de um **modelo apagado** são **cancelados**.
- O modelo desliga os e-mails "um destinatário assinou" e "documento concluído" para o dono, para o administrador não
  receber milhares de avisos. Os colaboradores continuam recebendo o convite e a cópia assinada.

## Privacidade

- O quadro e a planilha da situação **não mostram CPF**.
- Os registros técnicos (logs) **não trazem nome nem e-mail**.
- As linhas da planilha enviada são **apagadas** depois de processadas.

## Testes

- Suíte: `scripts/revalle/tests/collaborator-contract.test.mjs` (roda contra a stack local, como as outras).
- Se o banco local foi apagado, rode antes `node scripts/revalle/tests/bootstrap-creds.mjs`: ele recria as contas e os
  tokens de teste.
