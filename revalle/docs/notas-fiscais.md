# RevSign — notas fiscais e conta contábil (Fases 5 e 6)

Guia para o Enzo e para a TI. Explica como configurar a sugestão de conta contábil, o que o remetente vê, a página
**Notas fiscais**, a planilha exportada e o trabalho do **Financeiro** (seção 9).

## Como funciona, em uma frase

Quando alguém envia uma nota fiscal (NF) para assinatura, o RevSign percebe que é uma NF, pede ao Gemini (Google) uma
sugestão de conta contábil e obriga o remetente a escolher a conta (ou "Deixar para o Financeiro") antes de
enviar. Quando todos assinam, a contabilidade recebe o PDF assinado por e-mail.

- Desde a Fase 6, a conta **faz parte do que é assinado**: quem assina vê "Nota fiscal · Conta contábil: {código} – {nome}",
  ela fica na prova de cada signatário e no certificado (com a aprovação do Financeiro). Ver `prova.md`. O carimbo não
  muda. Trocar a conta depois do envio cria uma nova versão, que todos assinam de novo.
- A sugestão é só uma sugestão: o RevSign nunca escolhe a conta sozinho.
- Sem a chave do Gemini, tudo funciona do mesmo jeito, só que sem sugestão: o remetente escolhe na lista.

## 1. Importar a lista de contas

No site, entre com uma conta de administrador e abra **Admin → Contas contábeis**.

O arquivo é um CSV separado por **ponto e vírgula**, com estas colunas, nesta ordem e com esta primeira linha:

```
numero;nome;descricao;tipo
2.1.03;Fornecedores;Compra de mercadorias e insumos a prazo;pagar
3.1.01;Serviços de terceiros;Serviços tomados de pessoa jurídica;pagar
1.1.02;Clientes;Vendas a prazo;receber
4.9.99;Outras despesas;;
```

- `numero`: o número da conta, do jeito que a contabilidade usa (ex.: `2.1.03`). Não pode repetir.
- `nome`: o nome curto da conta.
- `descricao`: quando usar a conta. É o que mais ajuda a IA a acertar; escreva em frases simples. Pode ficar vazia.
- `tipo`: `pagar`, `receber` ou vazio.
- Até 5.000 contas e 1 MB.

**Salvando no Excel:** **Arquivo → Salvar como → "CSV UTF-8 (delimitado por vírgulas)"**. Apesar do nome, o Excel em
português grava com ponto e vírgula. Se o arquivo vier em outro formato (o "CSV" comum do Excel), o RevSign tenta ler
como Windows-1252 e avisa na prévia. Se aparecer o erro "Salve o arquivo como CSV UTF-8", salve de novo com essa opção.

Passo a passo:

1. Envie o arquivo (ou cole o texto) e clique em **Ver prévia** (no arquivo, a prévia sai sozinha).
2. Confira o número de contas válidas. Se houver erro, a tela mostra a linha; corrija e envie de novo. Nada é gravado
   enquanto houver erro.
3. Clique em **Aplicar**.

**A lista nova substitui a atual.** Conta que sumiu da lista fica **inativa**: documentos antigos continuam mostrando
número e nome, mas ela não aparece mais para documentos novos. Nada é apagado. Se a conta voltar numa importação
futura, ela é reativada.

## 2. Editar o prompt

Na mesma tela, campo **Prompt**. É a instrução para a IA, em português, com as regras da empresa. Exemplo:

> Somos uma distribuidora. Compra de mercadoria para revenda vai em Fornecedores (2.1.03). Manutenção de veículos e
> empilhadeiras vai em Serviços de terceiros (3.1.01). Energia, água e telefone vão em Despesas gerais.

O RevSign acrescenta sozinho, depois do seu texto, a lista de contas ativas (número, nome, tipo e descrição) e o
formato da resposta. Você não precisa colar a lista no prompt.

**Cache por arquivo.** Cada arquivo (pelo seu SHA-256, uma "impressão digital" do PDF) vai ao Gemini **uma vez só**. Se
o mesmo PDF for enviado de novo, a sugestão vem do cache, sem nova chamada. Por isso:

- **Trocar o prompt ou a lista não refaz as sugestões já feitas.** Elas continuam como estavam.
- Exceção: se a conta sugerida ficou inativa, a sugestão guardada não é usada e a IA é chamada de novo.
- O botão **"Sugerir de novo"** (no diálogo de envio) ignora o cache e chama a IA com o prompt e a lista atuais.

## 3. E-mail da contabilidade e chave do Gemini

- **E-mail da contabilidade:** na mesma tela, campo **E-mail da contabilidade**. Quando uma NF é concluída (todos
  assinaram), esse endereço recebe o PDF assinado, com o título, o remetente, a data e a conta no assunto. Um e-mail por
  NF, uma vez só. Vazio = ninguém recebe. NF recusada ou cancelada não gera e-mail.
- **Trocar a conta depois da conclusão não reenvia o e-mail**: a contabilidade fica com a conta que estava no e-mail.
  A conta atual está sempre na página **Notas fiscais** e na planilha; confira por ela.
- **Chave do Gemini:** no EasyPanel, serviço `revsign` → **Environment**, defina `GEMINI_API_KEY` com a chave do
  [Google AI Studio](https://aistudio.google.com/apikey) e faça o **Deploy**. A chave fica só no servidor; nunca vai para
  o navegador nem para o repositório.
- A tela de admin mostra o estado: "Gemini configurado (modelo …)", "sem chave do Gemini" ou "desligada".
- Para desligar a IA sem apagar a chave: `NEXT_PRIVATE_REVALLE_INVOICE_AI=disabled`.
- Modelo: `NEXT_PRIVATE_REVALLE_GEMINI_MODEL` (padrão `gemini-3.6-flash`). Precisa ser Gemini 2.5 ou mais novo.

## 4. O que o remetente vê

1. Ele sobe o PDF e clica em **Enviar documento**. Se for NF, o diálogo mostra o bloco **Nota fiscal · Conta contábil**.
2. Enquanto a IA pensa, aparece "Buscando sugestão…" (até uns 20 segundos). Depois, a sugestão com o motivo e o
   botão **Usar sugestão**. Ele também pode buscar outra conta na lista (por número ou nome) ou escolher **Deixar para
   o Financeiro**.
3. O botão **Enviar** só libera depois da escolha. Com uma conta, o documento sai e a NF fica aguardando a aprovação do
   Financeiro. Com **Deixar para o Financeiro**, o envio fica **retido**: o documento continua rascunho, nenhum convite
   sai, a tela avisa "Enviado para o Financeiro definir a conta. Os convites saem depois disso." e os membros do
   Financeiro recebem o e-mail "Nota fiscal aguardando o Financeiro: {título}". Quando alguém do Financeiro define a
   conta, o RevSign envia o documento em nome do dono (a conta já conta como aprovada).
4. Se o RevSign não tiver certeza (PDF escaneado, sem texto), pergunta "Este documento é uma nota fiscal?" e o botão
   **Enviar** fica bloqueado até a resposta ("Responda para enviar"). Com "Sim", o PDF vai para a IA e a conta é
   escolhida como numa NF comum; com "Não", o documento segue como um documento comum. Se o RevSign errou e não é NF,
   há o botão **Não é nota fiscal**.
5. Depois do envio, a página do documento mostra ao dono e ao admin:
   - numa NF, o cartão **Conta contábil**, só de leitura: a conta e a situação no Financeiro ("Aguardando aprovação
     do Financeiro", "Aprovada pelo Financeiro" ou, se o Financeiro trocou a conta, "Substituída…" com o botão **Abrir a
     nova versão**). Depois do envio, quem troca a conta é o Financeiro;
   - num PDF escaneado enviado sem a resposta (pela API), o cartão **Conta contábil** com a pergunta "Este documento é
     uma nota fiscal?" e o botão **Marcar como nota fiscal**;
   - num documento comum (ou numa NF enviada antes desta versão), só uma linha discreta: "É uma nota fiscal?
     **Marcar como nota fiscal**". Nada de cartão, para não pesar na página de cada contrato.

   Marcar coloca o documento no fluxo, sem chamar a IA, aguardando a aprovação do Financeiro; em seguida o cartão pede
   a conta (só a primeira escolha; depois, quem troca é o Financeiro). Se o documento já estava **concluído**, a
   contabilidade recebe o e-mail quando o Financeiro aprovar a conta (uma vez só).
6. **Conclusão retida.** Quando todos assinam uma NF que ainda aguarda a aprovação do Financeiro, ela **não é
   concluída**: o documento continua pendente, o PDF não é selado e os membros do Financeiro recebem um e-mail
   "Nota fiscal aguardando aprovação do Financeiro: {título}" (um por NF). Quando alguém do Financeiro aprova a conta,
   o documento é selado na hora e a contabilidade recebe o e-mail. Se o Financeiro aprovar antes de todos assinarem, a
   NF é concluída normalmente quando o último assinar. A retenção vale em todos os caminhos que selam (conclusão,
   varredura automática, remoção de destinatário pelo admin, reselagem pelo admin). NF recusada não é retida, e as NFs
   de antes da Fase 6 (`LEGACY`) concluem como antes. Uma versão **substituída** pelo Financeiro (conta trocada) e
   ainda não concluída nunca é selada. Se a selagem disparada pela aprovação se perder, a varredura automática a refaz
   (de 15 minutos a 6 horas depois da aprovação). A aprovação fica no log de auditoria do documento (também no PDF).
   Pela API: `revalle.finance.approve({ envelopeId })`, só para membros do Financeiro; repetir não faz nada.
7. No menu, **Notas fiscais** lista as NFs que ele enviou ou que chegaram para ele assinar (inclusive a NF retida para
   o Financeiro e as versões substituídas).

**NF enviada pela API ou por modelo:** o documento é criado, mas o envio é recusado (`INVOICE_ACCOUNT_REQUIRED`) até a
conta ser escolhida na tela. O documento fica como rascunho: abra-o no site, escolha a conta e envie. Documento na versão antiga
(criado por um modelo antigo ou pela API v2-beta de documento) abre no editor antigo, que mostra o bloco **Nota fiscal · Conta contábil** no topo. Usar
modelo com "enviar" e envio em lote fazem o mesmo. Detalhes em `revalle/docs/deploy.md`, seção "Notas fiscais enviadas
pela API ou por modelo".

**PDF escaneado pela API:** o servidor não exige a resposta a "É nota fiscal?" (só a tela exige). Pela API, o PDF sem
texto é enviado como documento comum: fica fora da lista e da planilha e não gera e-mail. Se era NF, use **Marcar como
nota fiscal** na página do documento (item 5).

**NFs enviadas antes desta atualização** não têm classificação: não aparecem em **Notas fiscais** nem na planilha, e a
contabilidade não recebe e-mail delas. Para colocar uma delas no fluxo, use **Marcar como nota fiscal** (item 5).

## 5. Página "Notas fiscais" e planilha

No menu do site, **Notas fiscais**. Cada pessoa vê as NFs já enviadas em que está envolvida: as que enviou e as que
chegaram para ela assinar. O **administrador** e quem é do **Financeiro** veem todas.

Desde a Fase 6 também aparecem:

- o **rascunho que está com o Financeiro** (o remetente escolheu "Deixar para o Financeiro", ou a conta já foi aprovada
  e o envio ainda não saiu), para o Financeiro e para quem enviou. A coluna de envio diz "não enviada". Outros
  rascunhos continuam fora;
- a **versão substituída** (o Financeiro trocou a conta), para quem enviou, quem assina e o Financeiro, mesmo que o
  documento tenha sumido das listas comuns do RevSign.

**NF excluída pelo remetente:** some para quem enviou e para quem assinou, mas o administrador continua vendo (a
contabilidade pode já ter lançado a nota). Na tela ela aparece com a marca **excluído pelo remetente**; na planilha, a
coluna `status` diz `excluído pelo remetente`.

A lista vem da mais recente para a mais antiga pela **data de envio**.

Colunas: título, remetente, data de envio, status, conta (número · nome, "A definir pelo Financeiro" no rascunho que
espera o Financeiro, ou "A definir pela contabilidade" na NF de antes da Fase 6 deixada para a contabilidade), "Sugestão
aceita?" (Sim, Não ou "sem sugestão", quando não havia sugestão na hora da escolha), **Situação no Financeiro**
(Aguardando a conta, Aguardando aprovação, Aprovada, Substituída ou "Antiga, sem aprovação", para NF de antes da Fase
6) e **Versão** (v1, v2…).

O título abre o documento: quem enviou vai para a página do documento; o admin, para o painel do admin; quem é do
Financeiro e quem assina, para a **página da NF** (só leitura, seção 9).

Filtros: período de envio (dias no horário de Brasília), status, **Situação no Financeiro**, número da conta e "Só as
deixadas para o Financeiro". Para quem é do Financeiro, a página abre em **Aguardando o Financeiro** (NFs esperando a
conta ou a aprovação); escolha **Todas** para ver o resto. O endereço `/notas-fiscais?financeiro=pendentes` abre direto
nesse filtro. Se a data inicial for depois da final, a tela avisa "A data inicial é depois da data final." e nada é
listado nem exportado.

**Exportar planilha** baixa `notas-fiscais-AAAA-MM-DD.csv` (data de hoje em Brasília) com os **mesmos filtros** da tela.
O arquivo abre direto no Excel (separador `;`, UTF-8 com BOM). Colunas:

| Coluna | O que é |
|---|---|
| `id` | Identificador do documento no RevSign |
| `titulo` | Título do documento |
| `remetente` | Nome de quem enviou (ou o e-mail, se não tiver nome) |
| `enviado_em` | Data e hora do envio (Brasília, `dd/mm/aaaa hh:mm`) |
| `concluido_em` | Data e hora em que todos assinaram (vazio se ainda não concluiu) |
| `status` | Pendente, Concluído, Recusado, Cancelado, ou `excluído pelo remetente` (só na planilha do admin) |
| `conta` | Número da conta; `a definir pela contabilidade` (NF de antes da Fase 6 deixada para a contabilidade) ou `a definir pelo Financeiro` (rascunho esperando o Financeiro) |
| `nome_conta` | Nome da conta (vazio quando ficou para a contabilidade) |
| `tipo` | `pagar`, `receber` ou vazio |
| `sugestao_ia` | Número da conta que a IA sugeriu (vazio se não houve sugestão) |
| `confianca` | Confiança da IA: `alta`, `media` ou `baixa` (vazio sem sugestão) |
| `aceitou_sugestao` | `sim`, `não`, ou vazio quando não havia sugestão |
| `link` | Endereço do documento no RevSign para quem exportou (dono: página do documento; admin: painel do admin; Financeiro e quem assina: página da NF) |
| `financeiro` | Situação no Financeiro, como na tela (ex.: `Aguardando aprovação`, `Aprovada`, `Substituída`) |
| `aprovado_por` | Quem do Financeiro aprovou (ou definiu) a conta; vazio se ainda não foi aprovada |

As colunas `financeiro` e `aprovado_por` (Fase 6) ficam **no fim**: as planilhas que já leem as colunas anteriores
continuam funcionando.

**Para a contabilidade: não lance as linhas com `financeiro` = `Substituída`.** Elas são versões que o Financeiro
substituiu ao trocar a conta (a mesma nota aparece de novo na linha da nova versão, com a conta certa). Uma versão
substituída pode aparecer como `Concluído` quando a troca foi feita depois da conclusão; mesmo assim, vale a linha da
nova versão.

Limite: **10.000 linhas** por planilha. Acima disso, a tela avisa "Filtre por período para exportar menos de 10.000
notas." e a planilha não é gerada. Textos que começam com `=`, `+`, `-` ou `@` ganham um `'` na frente, para o Excel não
tratar como fórmula.

## 6. Limites

- Só documento detectado (ou confirmado pelo remetente) como NF vai para a IA. Num documento com vários arquivos, só os
  arquivos que são NF vão; um contrato junto fica de fora.
- Até 20.000 caracteres de texto por arquivo; PDF escaneado vai cortado nas 5 primeiras páginas (como imagem).
- A IA tem 20 segundos para responder. Se demorar, errar o formato ou sugerir uma conta que não existe (ou está
  inativa), fica "sem sugestão" e o remetente escolhe na lista. Nada trava.
- 60 sugestões por usuário por hora, e no máximo 6 chamadas à IA por documento (a automática + 5 "Sugerir de novo" ou
  "Sim"/"Não").

## 7. Privacidade

- A política de privacidade (`/privacidade`) diz: "As notas fiscais enviadas para assinatura são analisadas por um
  serviço de inteligência artificial (Google Gemini) apenas para sugerir a conta contábil."
- E também: "No texto da nota, números de CPF são mascarados antes do envio; uma nota digitalizada (imagem) é enviada
  como está. Nunca enviamos a data de nascimento nem os dados da verificação de quem assina."
- Na prática: no texto, `123.456.789-09`, `123456789-09` e 11 dígitos logo depois de "CPF", "CPF nº" ou "CPF/CNPJ"
  viram `***.***.***-**`; CNPJ (14 dígitos) e a chave de acesso (44) ficam. Uma NF escaneada (foto ou digitalização)
  vai como imagem, e o CPF que estiver nela vai junto: não há texto para mascarar.
- O log do servidor registra só o modelo, os tokens, a duração, o resultado e, quando o Google recusa, o código HTTP
  (ex.: 429 = cota, 403 = chave, 404 = modelo retirado); nunca o texto da NF nem a resposta do Google.
- **Cache das sugestões:** a tabela `RevalleInvoiceSuggestionCache` guarda, por SHA-256 do arquivo, a conta sugerida,
  a confiança, o modelo e o motivo escrito pela IA (que pode citar o nome do fornecedor ou do tomador). Não tem prazo
  e não é apagada quando o documento é excluído. Para limpar (as NFs seguintes voltam a chamar a IA):
  `delete from "RevalleInvoiceSuggestionCache";` no banco.
- A chave fica só no servidor (EasyPanel).

## 8. Problemas comuns

- **"Sem sugestão" sempre:** confira na tela de admin se aparece "Gemini configurado". Se aparecer "sem chave", defina
  `GEMINI_API_KEY`. Se a lista de contas estiver vazia, não há o que sugerir.
- **A NF não foi reconhecida:** o RevSign procura sinais de NF no texto (DANFE, chave de acesso, NFS-e etc.). PDF
  escaneado sem texto gera a pergunta "Este documento é uma nota fiscal?"; num documento escaneado comum, basta
  responder "Não" para enviar. Um documento comum com texto nunca é bloqueado.
- **A contabilidade não recebeu o e-mail:** confira o campo na tela de admin e se a NF está **Concluída** (todos
  assinaram). O e-mail sai uma vez só; reselar o documento não reenvia.

## 9. Financeiro (Fase 6)

Toda nota fiscal passa pelo **Financeiro** antes de ser concluída: alguém do Financeiro **aprova** a conta escolhida ou
**troca** a conta, com o motivo. NFs concluídas antes da Fase 6 ficam como estão.

### Quem é do Financeiro

O administrador marca em **Admin → Financeiro**: busque a pessoa pelo nome ou e-mail e marque a caixa **Financeiro**
(vale na hora; desmarcar tira o acesso na hora). Os avisos do Financeiro vão para todos os membros marcados. Se não
houver ninguém marcado e houver NF esperando, a tela do admin mostra um alerta.

### O que o Financeiro vê

- Em **Notas fiscais**, **todas** as NFs, começando pelo filtro **Aguardando o Financeiro**.
- Clicando no título, a **página da NF**, só de leitura: o PDF, o título, o remetente, quem assina e a situação de cada
  um, as versões (link para a anterior e a nova, quando houver) e o cartão **Financeiro**, com:
  - a conta atual e a situação;
  - quem escolheu a conta e quando;
  - a sugestão da IA (com a confiança e o motivo);
  - quem aprovou, quando já foi aprovada.
- Quem não é do Financeiro também abre a página da NF em que está envolvido (enviou ou assina), sem o cartão. Quem não
  é do Financeiro e não está na NF recebe "Nota fiscal não encontrada".

### Aprovar

Botão **Aprovar conta** (pede confirmação). A NF fica aprovada e:

- se todos já assinaram, o documento é selado na hora e a contabilidade recebe o e-mail;
- se ainda falta alguém, ele é concluído normalmente quando o último assinar;
- se a NF foi marcada como nota fiscal depois de concluída, a contabilidade recebe o e-mail na aprovação.

Quem é do Financeiro pode aprovar uma NF que ele mesmo enviou ou assina; o log de auditoria e o certificado registram
quem aprovou.

**NF marcada depois do envio, ainda sem conta.** O cartão mostra a lista de contas e o botão **Definir e aprovar**
(pede confirmação): a conta escolhida fica aprovada na hora, sem nova versão e sem ninguém assinar de novo (ninguém viu
conta ao assinar). Depois segue como na aprovação acima.

### Trocar a conta

Botão **Trocar conta** (com a NF aguardando aprovação, aprovada ou já concluída): escolha a nova conta na lista e
escreva o **motivo** (de 10 a 500 caracteres; o contador mostra quantos já foram). Antes de trocar, a tela confirma:
"Todos vão assinar de novo uma nova versão."

- A versão atual vira **Substituída** e não pode mais ser assinada: quem abrir o link antigo vê "Este documento foi
  substituído por uma nova versão (conta contábil alterada).". Se ela já estava concluída, continua concluída.
- O RevSign cria uma **nova versão** (mesmo PDF, mesmas pessoas e campos, título com " (v2)", " (v3)"…), já com a
  conta nova aprovada, e envia na hora. A tela abre a página da nova versão.
- Quando a nova versão é enviada, o remetente e todos que assinam (das duas versões) recebem o aviso "Conta contábil da
  nota fiscal alterada pelo Financeiro: {título}", com o texto "A conta contábil da nota fiscal {título} foi alterada
  pelo Financeiro de {antiga} para {nova}. Motivo: {motivo}.". O botão leva cada um aonde ele entra: quem assina a nova
  versão, ao próprio link de assinatura (**Assinar a nova versão**); o remetente, à página da NF (**Abrir a nova
  versão**); quem não está na nova versão (ou só recebe cópia), ao **/verificar**.
- Se a nova versão foi criada mas o envio dela falhou (ex.: e-mail de um destinatário fora da empresa), a tela avisa
  "Conta trocada, mas a nova versão não foi enviada" com o motivo. O remetente pode corrigir o rascunho e enviar, ou o
  Financeiro, depois da correção, usa **Enviar de novo** no cartão da nova versão (mesma conta, pede confirmação). O
  aviso da troca só sai quando a nova versão é enviada.
- Se a nova versão foi apagada pelo remetente (ou a troca parou no meio e passaram 5 minutos), o cartão da versão
  substituída diz "A nova versão não existe mais: troque a conta de novo." e volta a mostrar **Trocar conta**; o link
  **Abrir a nova versão** só aparece enquanto a nova versão existe.
- Se outra pessoa do Financeiro aprovou ou trocou a conta no mesmo instante, a tela avisa "A situação desta nota mudou.
  Atualize a página e tente de novo."; a conta e o motivo digitados continuam no diálogo.

### "Deixar para o Financeiro"

Quando o remetente escolhe **Deixar para o Financeiro**, nada é enviado: o documento fica como rascunho e o Financeiro
recebe o e-mail. Na página da NF, o cartão mostra a lista de contas e o botão **Definir conta e enviar** (pede
confirmação): a conta já conta como aprovada e o RevSign envia o documento em nome do dono. Se aparecer "Envio em
andamento. Aguarde um instante.", outra pessoa do Financeiro acabou de enviar: espere e atualize (um envio que parou no
meio pode ser retomado depois de 5 minutos). Se aparecer "O remetente trocou o arquivo; a nota voltou para ele.", o
remetente substituiu o PDF do rascunho enquanto isso: a NF voltou a ser um rascunho dele, que escolhe a conta (ou deixa
para o Financeiro) de novo.

### E-mails do Financeiro

| E-mail | Quando sai | Para quem | Botão |
|---|---|---|---|
| "Nota fiscal aguardando o Financeiro: {título}" | O remetente deixou a conta para o Financeiro | Todos os membros | **Abrir a nota fiscal** (página da NF) |
| "Nota fiscal aguardando aprovação do Financeiro: {título}" | Todos assinaram e falta a aprovação | Todos os membros | **Abrir a nota fiscal** (página da NF) |
| "Conta contábil da nota fiscal alterada pelo Financeiro: {título}" | A nova versão de uma troca de conta foi enviada | O remetente e quem assina, das duas versões | **Assinar a nova versão** (quem assina), **Abrir a nova versão** (remetente) ou **Verificar um documento** (os demais) |

Cada um sai uma vez por NF (o aviso da troca, uma vez por pessoa). Se a última assinatura chegou quando ninguém estava
marcado como Financeiro (ou o pedido falhou), a varredura de selagem, que roda a cada 15 minutos, manda o pedido de
aprovação assim que houver alguém no Financeiro.

### E-mail da contabilidade depois do Financeiro

O e-mail "Nota fiscal assinada: …" (seção 3) diz quem escolheu a conta:

- o remetente escolheu: "A conta foi escolhida pelo remetente." (ou "…sugerida pela IA e aceita pelo remetente.");
- o Financeiro definiu ("Definir conta e enviar" ou "Definir e aprovar"): "Conta definida pelo Financeiro ({nome})";
- nova versão de uma troca: "Conta alterada pelo Financeiro ({nome}) — motivo: {motivo}".

Quando a versão anterior **já tinha ido para a contabilidade** (a troca foi feita depois da conclusão), o e-mail da nova
versão traz também "Substitui o envio da versão anterior: {título da versão anterior}": lance a nova e desconsidere a
anterior. NF de antes da Fase 6 sem conta chega com "Conta: a definir pela contabilidade".

### Documentos não selados (admin)

Em **Admin → Documentos não selados**, uma NF com todos assinados que espera a aprovação aparece com a marca
**Aguardando o Financeiro**, e uma versão substituída com **Versão substituída**. Não estão travadas: não precisa
resselar. A coluna **Parado há** fica vazia para elas.

Resselar (no painel do admin) uma NF **já concluída** que ainda espera a aprovação (marcada como NF depois da conclusão)
refaz o PDF selado normalmente; a aprovação continua pendente e a contabilidade só recebe o e-mail quando o Financeiro
aprovar. Uma NF ainda pendente que espera a aprovação não é selada pela reselagem: quem a libera é a aprovação.

