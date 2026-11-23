# Contratos para colaboradores (v.22)

Para quem: administradores do RevSign. Serve quando a empresa tem **um contrato que todos os colaboradores precisam
assinar**. O representante da empresa assina primeiro; depois cada colaborador recebe por e-mail o seu próprio
documento, já com a assinatura do representante, e assina **sem precisar de conta**.

**Só administradores do sistema** veem e usam a página. No menu lateral, o item é **Contratos para colaboradores**
(logo abaixo de Notas fiscais). Quem não é admin não vê o item, e o endereço da página manda de volta para o início.

A página substituiu as telas da v.21 (modelo, envio em massa por planilha e quadro "Envio para colaboradores"), que
foram removidas. Contratos criados na v.21 continuam funcionando: aparecem na lista com a marca "versão anterior" e só
permitem **Baixar situação**.

## Criar um contrato (assistente)

Clique em **Novo contrato**. A tela tem 3 passos e, no fim, **Revisar e enviar**.

### 1. Contrato
- **Título**, por exemplo "Termo de confidencialidade 2026".
- **PDF**: um arquivo, até **10 MB**.
- Dois quadros para arrastar até o lugar certo no PDF: **Assinatura do representante** (azul) e **Assinatura do
  colaborador** (verde). Cada um começa na última página e pode mudar de página. **Os dois são obrigatórios.**
- Pelo teclado: setas movem o quadro, Shift + setas mudam o tamanho. O quadro nunca sai da página.
- No celular a tela pede uma tela maior para posicionar os quadros.

### 2. Representante
- O e-mail de quem assina pela empresa (tem de ser e-mail da empresa). Se o e-mail já tem conta, aparece "Conta: {nome}".
- Ele recebe o contrato **primeiro**. Quem não tem conta precisa criar uma para assinar.

### 3. Colaboradores
- Duas abas: **Colar da planilha** e **Subir arquivo** (`.xlsx` ou `.csv`).
- Colunas **nome**, **e-mail** e **CPF**, **em qualquer ordem**, com ou sem cabeçalho (sem cabeçalho, a ordem é nome,
  e-mail, CPF). CPF com ou sem pontos.
- Até **3.000 linhas**.
- A **prévia** mostra linhas verdes e vermelhas, o nome do RH ao lado do digitado (**vale o nome do RH**), o CPF
  mascarado e o resumo "N prontos · N com erro · N repetidos". Os erros possíveis, com estes textos:
  - **E-mail inválido**
  - **CPF inválido**
  - **CPF não está na base do RH**
  - **Colaborador inativo no RH**
  - **CPF repetido na lista**
  - **E-mail repetido na lista**
- **Só as linhas prontas são enviadas.** Corrija a planilha e cole de novo quando quiser. **Baixar as linhas com erro**
  gera um arquivo com elas.
- Regra do "inativo": a situação do RH que contém *inativ*, *deslig*, *demit*, *rescis* ou *falecid* bloqueia, e também
  o valor falso/0/n/não. Qualquer outra situação conta como ativa.

### Revisar e enviar
- Resumo: título, páginas, representante, quantos colaboradores e a **estimativa** ("cerca de N horas, X e-mails por
  hora").
- **Nome do remetente**: o nome que aparece nos e-mails. Padrão **Revalle**.
- **Enviar para o representante** pede confirmação ("Enviar para o representante e, depois que ele assinar, para N
  colaboradores?").

### Rascunhos
- O contrato é salvo como **rascunho** sozinho, a partir do momento em que o PDF foi enviado ("Rascunho salvo").
- Na lista, clique no rascunho para continuar de onde parou.
- **A lista de colaboradores não fica guardada** no rascunho (por segurança, para não guardar CPF): ao retomar, cole ou
  suba a lista de novo.
- **Excluir rascunho** apaga o rascunho e o PDF enviado (só rascunho; contrato já enviado não pode ser excluído).

## Depois de enviar

1. O **representante** recebe o contrato primeiro.
2. Quando ele **assina**, a fila dos colaboradores começa **sozinha**. Não há botão de liberar.
3. Se ele **recusar**, o contrato fica **Recusado pelo representante** e nada é enviado aos colaboradores.
4. Se o envio ao representante **falhar** (aparece "Não foi possível enviar para o representante. Tente de novo."), use
   **Reenviar para o representante**. O mesmo botão serve se ele não recebeu o e-mail.

Os documentos saem em **filas**: uma tarefa roda **a cada 15 minutos** e envia `NEXT_PRIVATE_REVALLE_BULK_SEND_PER_HOUR`
dividido por 4 (padrão **100 por hora**, 25 a cada 15 minutos; 1.200 pessoas levam cerca de 12 horas). Cada documento
tem até **3 tentativas**; se falhar, fica "Falhou" com o motivo e a fila continua. O ritmo deve respeitar o limite do
SMTP do cPanel (veja `deploy.md`). Se algum documento não puder ser criado, a página avisa quantos colaboradores "não
puderam receber o documento".

## Página de acompanhamento

Abre ao clicar num contrato já enviado.
- **Etapas**: Representante (assinou em tal data), Envio (enviados/total) e Assinaturas, com barra de progresso e "X de
  Y assinaram".
- **Contagens e filtros**: Todos, Na fila, Enviado, Visualizado, Assinado, Recusado e Falhou.
- **Busca** por nome, e-mail ou CPF. A tabela mostra o CPF **mascarado**. No celular a tabela vira cartões.
- **Reenviar** por pessoa (para quem já recebeu o convite e ainda não assinou): no máximo **1 vez a cada 10 minutos**
  por pessoa.
- **Pausar envio** e **Retomar envio**, com confirmação. A fila para e volta de onde parou.
- **Baixar situação**: arquivo `.csv` com nome, e-mail, **CPF mascarado**, situação e data.
- A página **se atualiza sozinha a cada 30 segundos** (enquanto a aba está visível).

## Como o colaborador assina

- **Não precisa de conta**, mesmo com e-mail da empresa. Quem já tem conta entra normalmente.
- O sistema **sempre pede CPF e data de nascimento**, em toda assinatura. A data é conferida na base do RH.
- **Só vale o CPF da lista**: o documento fica amarrado ao CPF daquela pessoa. Outro CPF, mesmo existente na base,
  conta como erro (mensagem genérica, como no termo do Patrimônio). Isso impede alguém de assinar pelo outro.
- Essa assinatura **não cria vínculo entre e-mail e CPF**.
- O código de 6 dígitos por e-mail, o termo e o carimbo seguem como em qualquer documento.
- O certificado e a página `/verificar` trazem a linha **"Assinado pela empresa: {representante} em {data}, código
  {código}"**, com link para a verificação do documento do representante.

## Onde ficam os documentos

- Num **time próprio "Contratos para colaboradores"**, criado na primeira vez, na organização pessoal de **cada admin**.
  Assim a lista "Documentos" de ninguém fica lotada. Cada documento é aberto pela página do contrato.
- O time fica **escondido** do seletor de times de quem não é admin.
- O prefixo `contratos-colab-` no endereço de time é **reservado**: ninguém consegue criar um time com ele.
- Todos os admins veem todos os contratos na lista, mas abrem os documentos só pelo time de quem criou.

## E-mails

- Saem em nome de um **remetente fixo**: o assunto é `{Nome do remetente} enviou "{título}" para você assinar`.
- A resposta ao e-mail (Reply-To) vai para o **admin que criou** o contrato. O e-mail do admin **nunca aparece** no
  texto do e-mail para o colaborador.
- Vale também para reenvios e lembretes automáticos.
- O admin não recebe os e-mails "um destinatário assinou" nem "envio em massa concluído" desses documentos.

## O que fica protegido

- Só administrador do sistema pode editar, duplicar ou salvar como modelo os documentos do contrato. Documentos que
  falharam nas 3 tentativas são cancelados.
- A dispensa de conta vale só para estes contratos, nunca para documentos comuns.

## Privacidade

- O CPF aparece **mascarado** na tela e no arquivo baixado.
- Os registros técnicos (logs) **não trazem nome, e-mail nem CPF**.
- A lista enviada é **apagada** depois de processada; ficam só as linhas da fila.

## Testes

- `scripts/revalle/tests/collaborator-contract-page.test.mjs`: o motor (permissões, representante, fila, reenvio, gate
  do CPF, certificado, recusa). Roda contra a stack local.
- `scripts/revalle/tests/collaborator-contract-page-ui.test.mjs`: o navegador (assistente, rascunho, acompanhamento a
  1280 e 390 px, não admin). Roda com a imagem do Playwright.
- Se o banco local foi apagado, rode antes `node scripts/revalle/tests/bootstrap-creds.mjs`: ele recria as contas e os
  tokens de teste.
- Lembrete: a suíte antiga `collaborator-contract.test.mjs` (v.21) cobre os contratos da versão anterior.
