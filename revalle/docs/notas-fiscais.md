# RevSign — notas fiscais, conta contábil e centro de custo (Fases 5 a 9)

Guia para o Enzo e para a TI. Explica como configurar a sugestão de conta contábil, o que o remetente vê, a página
**Notas fiscais**, a planilha exportada e o trabalho do **Financeiro** (seção 9).

## Como funciona, em uma frase

Quando alguém envia uma nota fiscal (NF) para assinatura, o RevSign percebe que é uma NF, pede ao Gemini (Google) uma
sugestão de conta contábil e obriga o remetente a escolher a conta e o centro de custo antes de enviar. O RevSign não manda e-mail da nota
para a contabilidade nem para o Financeiro: tudo o que precisa de ação fica na página **Notas fiscais** (seção 5).

- Desde a Fase 6, a conta **faz parte do que é assinado**: quem assina vê "Nota fiscal · Conta contábil: {código} – {nome}",
  ela fica na prova de cada signatário e no certificado (com a aprovação do Financeiro). Ver `prova.md`. O carimbo não
  muda. Trocar a conta depois do envio cria uma nova versão, que todos assinam de novo.
- A sugestão é só uma sugestão: o RevSign nunca escolhe a conta sozinho.
- Desde a Fase 7, toda NF leva também um **centro de custo**, de uma lista fixa: 101 Puxada, 201 Armazém, 301
  Administrativo, 401 Vendas e 501 Entrega. Quem envia escolhe; a IA não participa. A NF só é enviada com a conta **e**
  o centro. Depois do envio, o centro já escolhido não muda pela página do documento: a correção é da Contabilidade, e
  gera uma nova versão que todos assinam de novo (seção 9, "Contabilidade").
- O centro de custo também **faz parte do que é assinado**: quem assina vê "Nota fiscal · Conta contábil: {código} – {nome}
  · Centro de custo: 101 – Puxada" (numa NF sem centro, a frase de antes; numa NF sem conta, marcada depois do envio,
  "Nota fiscal · Centro de custo: 101 – Puxada"), a prova de cada signatário guarda o centro que a pessoa viu, com ou sem
  conta, e o certificado ganha a linha "Centro de custo visto ao assinar" em cada signatário e a linha
  "Centro de custo: 101 – Puxada" no topo. O certificado e o `/verificar` só informam o centro: não dizem que a
  Contabilidade validou. Ver `prova.md`.
- Sem a chave do Gemini, tudo funciona do mesmo jeito, só que sem sugestão: o remetente escolhe na lista.
- Desde a Fase 9, um envio pode ter **várias notas fiscais e boletos**: cada nota tem a sua conta, o seu centro, a sua
  aprovação do Financeiro e a sua linha na lista, e o boleto é conferido com as notas (seção 10).

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

A IA só pode responder um código da lista: o RevSign manda os códigos das contas ativas como opções fechadas, e ela não
consegue inventar conta. Isso não garante a conta certa, por isso a sugestão continua sendo só uma sugestão. Se os
códigos somarem mais de 30 mil caracteres, essa trava sai sozinha, porque o Gemini recusa listas muito grandes; a
sugestão continua funcionando, e o RevSign descarta a resposta se a conta não existir. A lista real, de 138 contas,
soma menos de mil.

**Cache por arquivo.** Cada arquivo (pelo seu SHA-256, uma "impressão digital" do PDF) vai ao Gemini **uma vez só**. Se
o mesmo PDF for enviado de novo, a sugestão vem do cache, sem nova chamada. Por isso:

- **Trocar o prompt ou a lista não refaz as sugestões já feitas.** Elas continuam como estavam.
- Exceção: se a conta sugerida ficou inativa, a sugestão guardada não é usada e a IA é chamada de novo.
- O botão **"Sugerir de novo"** (no diálogo de envio) ignora o cache e chama a IA com o prompt e a lista atuais.

## 3. Chave do Gemini

- **Sem e-mail para a contabilidade.** A tela de admin não tem mais o campo **E-mail da contabilidade**, e o PDF
  assinado não é mais enviado por e-mail. A conta atual de cada nota está sempre na página **Notas fiscais** e na
  planilha; quem lança as notas confere por elas.
- **Chave do Gemini:** no EasyPanel, serviço `revsign` → **Environment**, defina `GEMINI_API_KEY` com a chave do
  [Google AI Studio](https://aistudio.google.com/apikey) e faça o **Deploy**. A chave fica só no servidor; nunca vai para
  o navegador nem para o repositório.
- A tela de admin mostra o estado: "Gemini configurado (modelo …)", "sem chave do Gemini" ou "desligada".
- Para desligar a IA sem apagar a chave: `NEXT_PRIVATE_REVALLE_INVOICE_AI=disabled`.
- Modelo: `NEXT_PRIVATE_REVALLE_GEMINI_MODEL` (padrão `gemini-3.6-flash`). Precisa ser Gemini 2.5 ou mais novo.

## 4. O que o remetente vê

1. Ele sobe o PDF e clica em **Enviar documento**. Se for NF, o diálogo mostra o bloco **Nota fiscal · Conta contábil**.
2. Enquanto a IA pensa, aparece "Buscando sugestão…" (até uns 20 segundos). Depois, a sugestão com o motivo e o
   botão **Usar sugestão**. Ele também pode buscar outra conta na lista (por número ou nome). Sem a sugestão (IA fora do
   ar, por exemplo), ele escolhe na lista do mesmo jeito. Se a lista de contas estiver vazia, o bloco diz "Nenhuma
   conta contábil cadastrada. Fale com o administrador." (mesmo que já houvesse uma conta escolhida) e nenhuma NF pode
   ser enviada.
   Logo abaixo da conta fica o **Centro de custo**: uma lista com os cinco centros, "Selecione o centro de custo".
   Na mesma chamada, a IA lê da nota o **fornecedor**, o **número** e o **valor total**, e o bloco os mostra abaixo da
   sugestão: "Lido pela IA: ACME Ltda · Nº 12345 · R$ 1.234,56" (só o que ela conseguiu ler). Veja a seção "Dados da
   nota lidos pela IA" mais abaixo.
   Cada nota também mostra a linha "No PDF: …", que diz se a conta e o centro serão impressos e onde (seção "A conta e o
   centro de custo no PDF final"); ela não trava o envio.
3. O botão **Enviar** só libera depois das duas escolhas, a conta e o centro de custo. Com as duas, o documento sai e a
   NF fica aguardando a aprovação do Financeiro. Se a conta escolhida saiu da lista antes do envio (ficou inativa), o
   envio é recusado do mesmo jeito e a pessoa escolhe outra. A nova versão criada pelo Financeiro numa troca de conta
   leva o centro da versão anterior e não pede o centro de novo.
4. Se o RevSign não tiver certeza (PDF escaneado, sem texto), pergunta "Este documento é uma nota fiscal?" e o botão
   **Enviar** fica bloqueado até a resposta ("Responda para enviar"). Com "Sim", o PDF vai para a IA e a conta é
   escolhida como numa NF comum; com "Não", o documento segue como um documento comum. Se o RevSign errou e não é NF,
   há o botão **Não é nota fiscal**.
5. Depois do envio, a página do documento mostra ao dono e ao admin:
   - numa NF, o cartão **Conta contábil**, só de leitura: a conta, o centro de custo ("Centro de custo: 101 – Puxada")
     e a situação no Financeiro ("Aguardando aprovação do Financeiro", "Aprovada pelo Financeiro" ou, se o Financeiro
     trocou a conta ou a Contabilidade corrigiu o centro, "Substituída…" com o botão **Abrir a nova versão**). Depois do
     envio, quem troca a conta é o Financeiro e quem corrige o centro é a Contabilidade. Numa NF que ainda não tem centro (marcada depois do envio ou
     enviada antes da Fase 7), o dono ou o admin escolhe o primeiro no próprio cartão, sem nova versão, desde que a NF esteja enviada ou
     concluída (numa NF recusada, cancelada ou excluída o servidor recusa, como na Contabilidade). Essas NFs
     continuam sendo aprovadas e concluídas normalmente sem o centro;
   - num PDF escaneado enviado sem a resposta (pela API), o cartão **Conta contábil** com a pergunta "Este documento é
     uma nota fiscal?" e o botão **Marcar como nota fiscal**;
   - num documento comum (ou numa NF enviada antes desta versão), só uma linha discreta: "É uma nota fiscal?
     **Marcar como nota fiscal**". Nada de cartão, para não pesar na página de cada contrato.

   Marcar coloca o documento no fluxo, sem chamar a IA, aguardando a aprovação do Financeiro; em seguida o cartão pede
   a conta e o centro de custo (só a primeira escolha; depois, quem troca a conta é o Financeiro e quem corrige o centro
   é a Contabilidade).
6. **Conclusão retida.** Quando todos assinam uma NF que ainda aguarda a aprovação do Financeiro, ela **não é
   concluída**: o documento continua pendente e o PDF não é selado. Nenhum e-mail é enviado: o Financeiro encontra a NF
   em **Notas fiscais**, no filtro **Aguardando o Financeiro**. Quando alguém do Financeiro aprova a conta, o documento
   é selado na hora. Se o Financeiro aprovar antes de todos assinarem, a
   NF é concluída normalmente quando o último assinar. A retenção vale em todos os caminhos que selam (conclusão,
   varredura automática, remoção de destinatário pelo admin, reselagem pelo admin). NF recusada não é retida, e as NFs
   de antes da Fase 6 (`LEGACY`) concluem como antes. Uma versão **substituída** (conta trocada pelo Financeiro ou
   centro corrigido pela Contabilidade) e ainda não concluída nunca é selada. Se a selagem disparada pela aprovação se perder, a varredura automática a refaz
   (de 15 minutos a 6 horas depois da aprovação). A aprovação fica no log de auditoria do documento (também no PDF).
   Pela API: `revalle.finance.approve({ envelopeId })`, só para membros do Financeiro; repetir não faz nada.
7. No menu, **Notas fiscais** lista as NFs que ele enviou ou que chegaram para ele assinar (inclusive as versões
   substituídas).

**Várias notas e boletos no mesmo envio (Fase 9).** Com duas ou mais notas, ou com um boleto ou um arquivo sem texto
junto da nota, o diálogo de envio mostra um bloco por arquivo, na ordem dos arquivos:

- **nota:** "Nota 2 de 3 · nf-b.pdf", com a sugestão, "Lido pela IA", **Sugerir de novo**, a conta e o centro de custo
  daquela nota, e o botão **Não é nota fiscal** (o arquivo vira documento comum). Se a nota parece já ter sido enviada,
  o aviso dela tem a própria caixa "Sei disso e quero enviar mesmo assim". Se é a mesma de outra nota do envio: "Esta
  nota parece ser a mesma da nota 1 deste envio." (só aviso);
- **boleto:** "Boleto · boleto.pdf", com "Lido: Fornecedor · R$ 1.500,00 · vence 01/12/2026" e, em âmbar, os avisos da
  conferência com as notas (seção 10). Os avisos não impedem o envio;
- **sem texto (escaneado):** "Este arquivo é:" com **Nota fiscal**, **Boleto** e **Outro documento**;
- **documento comum** (contrato): uma linha "contrato.pdf · documento comum", com o mesmo seletor para corrigir o tipo.

**Enviar** só libera com a conta e o centro em todas as notas e com o tipo de todo arquivo sem texto respondido (a recusa
do servidor diz em qual falta: "Falta em: nf-c.pdf."). Trocar ou remover qualquer arquivo do rascunho apaga a escolha de
todas as notas, como antes (a sugestão de cada arquivo volta do cache, sem nova chamada). Com uma nota só (e um contrato
ao lado), o bloco continua o de sempre. Depois do envio, o cartão **Notas fiscais** da página do documento mostra a
conta, o centro e a situação no Financeiro de cada nota.

**NF enviada pela API ou por modelo:** o documento é criado, mas o envio é recusado (`INVOICE_ACCOUNT_REQUIRED`) até a
conta e o centro de custo serem escolhidos na tela. O documento fica como rascunho: abra-o no site, escolha a conta e o
centro e envie. Documento na versão antiga
(criado por um modelo antigo ou pela API v2-beta de documento) abre no editor antigo, que mostra o bloco **Nota fiscal · Conta contábil** no topo. Usar
modelo com "enviar" e envio em lote fazem o mesmo. Detalhes em `revalle/docs/deploy.md`, seção "Notas fiscais enviadas
pela API ou por modelo".

**PDF escaneado pela API:** o servidor não exige a resposta a "É nota fiscal?" (só a tela exige). Pela API, o PDF sem
texto é enviado como documento comum: fica fora da lista e da planilha. Se era NF, use **Marcar como
nota fiscal** na página do documento (item 5).

**NFs enviadas antes desta atualização** não têm classificação: não aparecem em **Notas fiscais** nem na planilha. Para
colocar uma delas no fluxo, use **Marcar como nota fiscal** (item 5).

### Nota fiscal só para e-mails da empresa (16/11/2026)

Desde 16/11/2026 um documento comum pode ir para qualquer e-mail (`verificacao.md`, "E-mail de fora da empresa"). A
**nota fiscal não**: todos os destinatários de uma NF precisam ter e-mail da empresa (`@revalle.com.br`,
`@revallenordeste.com.br` ou `@revallepe.com.br`). A regra vale em todos os caminhos:

- **Envio** (tela, API v1/v2, modelo, envio em lote e a nova versão do Financeiro ou da Contabilidade): o servidor
  recusa com `400 INVOICE_EXTERNAL_RECIPIENT` e a mensagem "Nota fiscal só pode ser enviada para e-mails da empresa
  (@revalle.com.br, @revallenordeste.com.br ou @revallepe.com.br). Troque o e-mail de fulano@gmail.com." O documento
  continua rascunho. A recusa vem antes da conferência da conta e do centro de custo. Na nova versão do Financeiro, o
  motivo aparece no erro `FINANCE_NEW_VERSION_NOT_SENT`, e a versão fica parada em rascunho como em qualquer envio que
  falha.
- **Diálogo de envio** (e o bloco da NF no editor antigo): o bloco **Nota fiscal · Conta contábil** mostra a mesma
  mensagem em vermelho e o botão **Enviar** fica bloqueado até o e-mail ser trocado. Vale também quando a NF foi
  detectada no upload, quando a pessoa responde "Sim" a "Este documento é uma nota fiscal?" e na nova versão parada.
- **Rascunho**: pôr um e-mail de fora num rascunho de NF é aceito (o editor salva sozinho enquanto a pessoa digita); a
  recusa é no envio, e o editor já avisa abaixo do e-mail ("Nota fiscal só vai para e-mails da empresa").
- **NF já enviada**: acrescentar ou trocar destinatário por um e-mail de fora, ditar um próximo assinante de fora ou
  informar um e-mail de fora ao assinar é recusado com a mesma mensagem.
- **Marcar como nota fiscal** (documento já enviado): com algum destinatário de fora, é recusado com a mesma mensagem
  (aparece num aviso na página do documento) e o documento continua comum.
- A **sugestão da IA** não muda: ela olha o arquivo, não os destinatários.
- **Não é nota fiscal**: quem envia pode desmarcar a NF (como antes). Aí o documento segue como documento comum e pode
  ir para o e-mail de fora; a troca fica registrada (quem e quando), como toda marcação.

### Dados da nota lidos pela IA (Fase 8)

Junto com a conta, a IA copia do documento o **fornecedor** (razão social de quem emitiu), o **número da nota**, o
**valor total** e a **chave de acesso** (44 números). Eles servem para quem trabalha com as notas achar e conferir cada
uma sem abrir o PDF. **Podem estar errados**: a IA lê o documento como uma pessoa com pressa. Por isso a tela sempre diz
"Lido pela IA" e, na página da nota, "Lidos pela IA, confira no PDF".

- **Onde aparecem:** no bloco da nota, no diálogo de envio ("Lido pela IA: …"); na lista **Notas fiscais**, numa linha
  menor abaixo do título (com a legenda "Fornecedor, número e valor: lidos pela IA, confira no PDF." acima da tabela, que
  só aparece quando alguma nota da página tem esses dados: no celular não há como passar o mouse); na página da nota, no
  bloco **Informações** (Fornecedor, Número, Valor); e na planilha, nas colunas `fornecedor`, `numero_nf` e `valor`. Quem
  vê a lista ou a página vê os dados.
- **Onde não aparecem:** na tela de assinatura, na prova de quem assinou, no certificado do PDF selado e no
  `/verificar`. Eles não fazem parte do que é assinado.
- **Ninguém edita** esses dados. Para mudar, o jeito é pedir outra sugestão (**Sugerir de novo**), que lê a nota de novo.
- **Quando a IA não lê ou lê algo sem sentido,** o campo fica vazio e a sugestão de conta continua valendo. Isso vale
  para texto no lugar do valor, valor zero ou negativo (ou maior que R$ 21.474.836,47), chave de acesso que não passa na
  conferência do dígito, a palavra `null`, `N/A` ou `Não informado` escrita no lugar do dado (maiúsculas e minúsculas
  valem igual) e resposta sem os campos. Sem a IA ligada, ou com a sugestão falhando, os campos ficam vazios e
  tudo funciona como antes. O fornecedor é cortado em 200 caracteres e o número em 60; quebras de linha viram espaço.
- **Notas que já tinham sugestão antes da Fase 8** não têm esses dados. A sugestão guardada daquele arquivo deixa de ser
  reaproveitada, e a próxima vez que ele passar por uma sugestão (um documento novo com o mesmo arquivo, ou **Sugerir de
  novo**) a IA é chamada uma vez e os dados passam a existir. Nota já enviada não é lida de novo sozinha.
- A **nova versão** de uma nota (troca de conta pelo Financeiro ou correção do centro pela Contabilidade) leva os
  mesmos dados. **Trocar o arquivo** do rascunho, ou marcar **Não é nota fiscal**, apaga os dados.
- A **chave de acesso** lida fica guardada junto da sugestão e entra no alerta de nota duplicada (próxima seção). O
  **fornecedor** sai com os números de CPF escondidos (`***.***.***-**`): o nome de um MEI costuma terminar no CPF do
  dono, e uma nota escaneada chega à IA sem máscara.

### Alerta de nota duplicada (Fase 8)

O RevSign avisa quando uma nota **parece já ter sido enviada**, para ninguém pagar a mesma nota duas vezes. O aviso é um
alerta: **ninguém é impedido**. Quem decide é a pessoa (e, depois do envio, o Financeiro e a Contabilidade).

**Quando uma nota é "possível duplicada".** Quando **outra nota** tem **uma chave de acesso em comum** ou **o mesmo
arquivo**, e essa outra nota:

- já foi enviada (pendente ou concluída);
- não foi recusada, cancelada nem excluída;
- não é uma versão substituída (a troca de conta e a correção do centro criam uma nova versão: a nova nunca acusa a
  anterior, mas continua acusando uma terceira nota).

A própria nota também precisa estar "viva" para mostrar o alerta: uma nota substituída, recusada, cancelada ou excluída
não mostra. Rascunho de outra pessoa não conta.

**De onde vêm as chaves.** Só a chave **própria** da nota conta. O RevSign olha cada página dos arquivos detectados como
nota fiscal e para na **primeira** chave de acesso estruturalmente válida (44 números, com UF, mês, CNPJ e dígito
verificador certos, de **qualquer** modelo): se ela for dos modelos 55 NF-e, 57 CT-e, 65 NFC-e ou 67 CT-e OS, é guardada, sem
repetir. Um DANFE ou um DACTE imprime a chave dele no cabeçalho e a repete em cada página; as que vêm depois são de notas
citadas. Parar em qualquer modelo evita que um DAMDFE (modelo 58) adote a chave que cita, e a **página de NFS-e sem DANFE
não fornece chave** (a NFS-e não tem chave de 44 números, então a que aparece nela é de uma nota citada). A chave que a IA
leu só é somada quando o **texto dos arquivos não trouxe nenhuma chave** (em geral o PDF escaneado): num PDF com texto e
com a chave própria, uma citação devolvida pela IA não entra. A IA é instruída a copiar a chave **desta nota**, não as de notas citadas. Só a nota nova (ou
que teve o arquivo trocado) guarda chaves, e trocar o arquivo refaz a lista; **as notas que já existiam são achadas pelo
mesmo arquivo**, não pela chave. Uma nova versão leva as chaves da anterior.

**O que o alerta não pega.**
- Uma NFS-e (nota de serviço) com **arquivo diferente** não é achada: ela não tem chave de 44 números, e o número lido
  pela IA não é confiável o bastante para acusar.
- Uma nota **sem chave** (por exemplo, uma NFS-e) com **arquivo diferente** continua não sendo achada. Desde a Fase 9 o
  arquivo comparado é o **da nota**, não o conjunto do envio: a mesma NFS-e reenviada com um anexo a mais **é** achada.
- Uma nota que **cita** a chave de outra (uma devolução que traz a chave da nota original, um CT-e que lista as NF-e
  transportadas) normalmente **não acusa a original, nem é acusada por ela**: a chave citada não entra. O limite está nos
  layouts fora do comum: um que imprime uma chave citada **antes** da própria pode tanto **não achar** uma duplicada quanto
  **acusar por engano**, e uma página de continuação **sem chave própria** pode trazer a citada. (O mesmo arquivo ainda
  acusa.)
- Quando o texto não trouxe chave nenhuma (um escaneado, ou uma NFS-e com texto) e a IA devolve a chave de uma nota
  **citada** em vez de deixar vazio, ela entra e pode acusar por engano. O prompt pede só a chave desta nota, mas a IA pode
  errar.

**Onde aparece, e para quem.**

| Onde | Quem vê | O que mostra |
|---|---|---|
| Diálogo de envio, no bloco da nota | Quem está enviando | Alerta âmbar "Esta nota parece já ter sido enviada", uma linha por nota ("Enviada em 05/11/2026 10:00 por Maria · Pendente"; até 5, da mais antiga para a mais nova) e a caixa **Sei disso e quero enviar mesmo assim**. O botão **Enviar** só libera depois de marcar. **Sem título e sem link**, porque a pessoa pode não ter acesso à outra nota. |
| Cartão "Conta contábil" do documento já enviado | O dono e o admin | O mesmo aviso, sem a caixa e sem link |
| Lista **Notas fiscais** | Só Financeiro, Contabilidade e admin | O selo **Possível duplicada** abaixo do título. O colaborador comum não recebe a marca (a consulta nem roda para ele) |
| Página da nota | Financeiro, Contabilidade e admin | O alerta com o **título**, a data, o remetente, a situação e o **link** de cada outra nota. O dono vê o alerta **sem título e sem link**. Quem só assina não vê |
| Planilha | Quem exporta | Colunas `chave_acesso` e `possivel_duplicada` (`sim` ou vazio; o `sim` só para Financeiro, Contabilidade e admin) |

- Se a chave da IA chegar **com o diálogo de envio aberto** (nota escaneada), o alerta aparece na hora e o botão
  **Enviar** volta a ficar travado até a confirmação.
- No **editor antigo** (documento criado pela API v1 ou por modelo antigo) o alerta aparece, mas **sem a caixa de
  confirmação**: o botão de enviar daquele editor não espera pelo bloco, então a caixa não destravaria nada.
- O alerta **some** quando a outra nota é recusada, cancelada, excluída ou substituída.
- **Pela API o envio não é bloqueado**: a confirmação existe só na tela. Aprovar e validar continuam possíveis; o
  Financeiro e a Contabilidade decidem olhando o alerta.
- Os dados do alerta (chaves, nomes e datas) **não vão para o log**.

**Por nota (Fase 9).** Num envio com várias notas, o alerta é de cada nota: compara as chaves e o arquivo **daquela
nota** com as notas de outros envios. O diálogo, o cartão, a página da NF (na seção da nota), a lista e a planilha
(`possivel_duplicada`) marcam só a nota repetida. **A mesma nota duas vezes no mesmo envio** (mesmo arquivo ou chave em
comum) mostra no diálogo "Esta nota parece ser a mesma da nota 1 deste envio." Não trava o envio e não conta como
duplicada de outro envio.

### A conta e o centro de custo no PDF final

O texto da conta e do centro no PDF final da nota é **opcional** e sai **onde o remetente colocar o bloco**. No PDF final
(depois que todos assinam e o Financeiro aprova), a selagem escreve, **em azul**, dentro do bloco:

```
Conta: 342401 - Manutenção Predial
CC: 201 - Armazém
```

**O bloco "Conta e centro de custo".** No editor, no passo **Adicionar campos**, há o botão **Conta e centro de custo**
abaixo de **Assinatura**. Arraste-o para a página da nota: o bloco aparece com o texto de exemplo ("Conta: (conta
aprovada)" e "CC: (centro de custo)"). Dá para mover, redimensionar (o tamanho mínimo é 6% da altura da página) e tirar.

- **Um bloco por arquivo.** Arrastar de novo no mesmo arquivo move o bloco que já existe (mantém o tamanho); trocar de
  arquivo mostra o bloco daquele arquivo. O bloco não é campo de assinatura: não tem destinatário, não conta em "cada
  signatário precisa de assinatura em cada documento" e nunca trava o envio. Só se edita enquanto o documento é
  rascunho, por quem pode editar os campos. Trocar o arquivo do rascunho apaga o bloco dele.
- **Também em modelo.** O bloco pode ser posto num modelo e vai para o documento criado a partir dele. Ele também é
  copiado ao duplicar o documento e na nova versão (troca de conta, correção do centro, "Enviar de novo").
- **Sem bloco, sem texto.** Só sai texto em arquivo que é **nota fiscal**, e só com conta aprovada ou centro escolhido:
  a nota sem centro sai só com a linha da conta; a sem conta aprovada (de antes da Fase 6, ou marcada como nota depois do
  envio) sai só com a do centro; sem nenhum dos dois, nada. Bloco em contrato, boleto ou outro arquivo, e em nota
  recusada, não imprime nada.
- **Várias notas (Fase 9):** cada arquivo de nota recebe o texto com a conta aprovada **dessa nota** e o centro dela, no
  bloco dela. Nota sem bloco fica sem texto.
- **O texto:** formato e azul de sempre, alinhado ao canto de cima, à esquerda. **Encolhe** (da fonte 10 até 6 pt) para
  caber e, se ainda não couber, **quebra** a linha, por palavra (uma palavra maior que o bloco quebra por letra).
  **Nunca é cortado**: no pé da página, o texto sobe para não sair. A conta é a que o Financeiro aprovou, com o nome da
  hora da aprovação (se a lista for reimportada com outro nome, o PDF continua com o nome aprovado); sem nome, só o
  código. O centro vem da lista fixa de centros.
- **Nunca no certificado.** O texto só entra nas páginas do arquivo da nota, nunca nas páginas do certificado. Vale em
  página com rotação e nos documentos das duas versões do editor. Se o bloco ficou numa página que não existe mais, a
  nota é selada sem o texto, e o log do servidor diz qual envio e `AnnotationPageMissing`.
- **Só no PDF final.** O arquivo original e a prévia da assinatura e da espera pelo Financeiro não mudam, e o SHA-256 do
  original continua o mesmo: o texto entra só na selagem. O certificado e o `/verificar` seguem como estavam.
- **No diálogo de envio**, cada nota mostra uma linha:
  - "No PDF: conta e centro na página 2." (há bloco naquele arquivo);
  - "No PDF: sem conta e centro (opcional — coloque o bloco no passo Adicionar campos)." (não há);
  - em âmbar, para bloco num arquivo que não é nota: "O bloco de conta e centro em contrato.pdf não será impresso: só
    sai em nota fiscal." O aviso não trava o **Enviar**.
- **Envios de antes da atualização** (já enviados quando o bloco passou a existir, as novas versões deles e os que
  estavam em rascunho de nova versão) mantêm o texto **automático** de antes, logo acima do carimbo da primeira
  assinatura **de cada nota**: a primeira de cada arquivo de nota, por página, de cima para baixo, da esquerda para a
  direita (não é a ordem dos destinatários); sem espaço acima, vai logo abaixo do campo e, se também não houver, acima
  encostado na margem de 18 pt; nota sem campo de assinatura leva o texto no alto da primeira página. Nesses envios o
  diálogo diz "No PDF: conta e centro acima da assinatura (envio de antes da atualização)." e o botão do bloco não
  aparece. Um envio de antes da atualização marcado como NF depois também fica no modo automático. Um documento
  duplicado pelo usuário **não** herda o modo automático (só o bloco, se houver).
- **Sem o editor novo, sem texto.** No editor antigo (documentos V1) não há o bloco, e na API o bloco não é posto: o
  envio sai sem o texto.
- **Nova versão** (troca de conta, correção do centro): sai do PDF original, então o texto antigo nunca fica por baixo; a
  versão anterior, já concluída, continua como foi selada. **Reselagem pelo admin** também parte do PDF original e
  escreve o mesmo texto, sem duplicar.
- **Se o texto não puder ser escrito** (por exemplo, a fonte não carregou), a nota é selada normalmente, sem ele, e o
  motivo vai para o log do servidor (`revalle invoice annotation`), sem dados da nota. Nesse caso, resselar o documento
  depois que o problema passar escreve o texto.

## 5. Página "Notas fiscais" e planilha

No menu do site, **Notas fiscais**. Cada pessoa vê as NFs já enviadas em que está envolvida: as que enviou e as que
chegaram para ela assinar. O **administrador**, quem é do **Financeiro** e quem é da **Contabilidade** veem todas.

Desde a Fase 6 também aparecem:

- o **rascunho de uma nova versão** (de uma troca de conta ou de uma correção do centro, aprovada ou aguardando
  aprovação, com o envio que ainda não saiu), para o Financeiro, a Contabilidade e quem enviou. A coluna de envio diz
  "não enviada". Outros rascunhos continuam fora: o rascunho comum de outra pessoa não aparece nem abre pelo endereço,
  para o Financeiro e para a Contabilidade. Esse rascunho também está nas filas **Aguardando o Financeiro** e
  **Aguardando a Contabilidade** e nos dois contadores (veja abaixo): o link antigo já está bloqueado e não há e-mail de
  aviso, então a nota só sai dali quando alguém usa **Enviar de novo**;
- a **versão substituída** (o Financeiro trocou a conta ou a Contabilidade corrigiu o centro), para quem enviou, quem
  assina, o Financeiro e a Contabilidade, mesmo que o documento tenha sumido das listas comuns do RevSign.

**NF excluída pelo remetente:** some para quem enviou e para quem assinou, mas o administrador continua vendo (a
contabilidade pode já ter lançado a nota). Na tela ela aparece com a marca **excluído pelo remetente**; na planilha, a
coluna `status` diz `excluído pelo remetente`.

A lista vem da mais recente para a mais antiga pela **data de envio**.

**Várias notas no mesmo envio (Fase 9).** A lista tem **uma linha por nota**: um envio com 3 notas aparece 3 vezes, com a
conta, o centro, a situação no Financeiro e a validação de cada nota, e uma linha menor "Nota 2 de 3 · nf-b.pdf". O
título abre a página da NF já na seção daquela nota. Dentro do envio, as notas seguem a ordem dos arquivos. O filtro de
conta e as filas valem por nota (uma nota já aprovada sai de **Aguardando o Financeiro** mesmo que as outras ainda
esperem). Os **contadores do menu contam notas**. Na lista de **Documentos**, um envio com várias notas mostra só a
etiqueta "3 notas fiscais". Envios de uma nota ficam exatamente como antes.

Colunas: título, remetente, data de envio, status, conta (número · nome; um traço quando a NF não tem conta, como a de
antes da Fase 6), **Centro de custo** ("101 – Puxada"; um traço quando a NF ainda não tem centro), "Sugestão aceita?"
(Sim, Não ou "sem sugestão", quando não havia sugestão na hora da escolha), **Situação no Financeiro** (Aguardando
aprovação, Aprovada, Substituída ou "Antiga, sem aprovação", para NF de antes da Fase 6), **Validação da Contabilidade**
(Aguardando validação, Validado, Sem centro de custo ou Sem validação, para a nota recusada, cancelada, substituída ou
excluída que ninguém validou) e **Versão** (v1, v2…).

O título abre o documento: quem enviou vai para a página do documento; o admin, para o painel do admin; quem é do
Financeiro, a Contabilidade e quem assina, para a **página da NF** (só leitura, seção 9).

Filtros: período de envio (dias no horário de Brasília), status, **Situação no Financeiro**, **Validação da
Contabilidade** e número da conta. A página abre na fila de cada perfil:

- quem é do **Financeiro** abre em **Aguardando o Financeiro** (NFs esperando a aprovação e novas versões que ficaram
  sem enviar), com ou sem a Contabilidade. O filtro **Aguardando aprovação**, da **Situação no Financeiro**, traz só as
  que esperam a aprovação;
- quem é **só da Contabilidade** abre em **Aguardando a Contabilidade** (NFs que ainda não tiveram o centro de custo
  validado, inclusive as sem centro, e novas versões que ficaram sem enviar);
- as outras pessoas abrem sem filtro.

Escolha **Todas** no filtro para ver o resto. Escolher uma fila solta a outra: quem tem os dois perfis e escolhe
**Aguardando a Contabilidade** deixa de ver só a fila do Financeiro. Os endereços `/notas-fiscais?financeiro=pendentes` e
`/notas-fiscais?contabilidade=pendentes` abrem direto nesses filtros (`contabilidade` aceita `pendentes`, `validadas` e
`todas`). **Aguardando a Contabilidade** não inclui nota recusada, substituída ou excluída pelo remetente (a nova versão
sem enviar, sim, mesmo já validada pela correção do centro, porque a Contabilidade também a envia de novo). **Aguardando
o Financeiro** também não inclui NF excluída pelo remetente, nem para o administrador que é do Financeiro. Se a data
inicial for depois da final, a tela avisa "A data inicial é depois da data final." e nada é listado nem exportado.

**Contador no menu.** Quem é do Financeiro ou da Contabilidade vê um número ao lado de **Notas fiscais**, no menu do
computador e no do celular: quantas notas esperam a pessoa (a fila do Financeiro e a da Contabilidade, somadas para quem
tem os dois perfis). Para quem tem **um** perfil, o número é o mesmo que a página mostra ao abrir na fila. Para quem tem
os **dois**, o contador é a **soma** das duas filas (uma nota que espera o Financeiro e a Contabilidade conta duas
vezes) e a página abre só na do Financeiro: o número do menu pode ser maior que a lista que aparece. Ele atualiza a cada
minuto e some quando não há nada esperando. Quem não tem perfil não vê contador. Não há e-mail de aviso.

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
| `conta` | Número da conta; vazio quando a NF não tem conta (NF de antes da Fase 6) |
| `nome_conta` | Nome da conta (vazio quando a NF não tem conta) |
| `tipo` | `pagar`, `receber` ou vazio |
| `sugestao_ia` | Número da conta que a IA sugeriu (vazio se não houve sugestão) |
| `confianca` | Confiança da IA: `alta`, `media` ou `baixa` (vazio sem sugestão) |
| `aceitou_sugestao` | `sim`, `não`, ou vazio quando não havia sugestão |
| `link` | Endereço do documento no RevSign para quem exportou (dono: página do documento; admin: painel do admin; Financeiro, Contabilidade e quem assina: página da NF) |
| `financeiro` | Situação no Financeiro, como na tela (ex.: `Aguardando aprovação`, `Aprovada`, `Substituída`) |
| `aprovado_por` | Quem do Financeiro aprovou (ou definiu) a conta; vazio se ainda não foi aprovada |
| `centro_custo` | Código do centro de custo (101, 201…); vazio quando a NF ainda não tem centro |
| `nome_centro_custo` | Nome do centro de custo (Puxada, Armazém…); vazio quando a NF ainda não tem centro |
| `validacao_contabilidade` | `Aguardando validação`, `Validado`, `Sem centro de custo` ou `Sem validação` (nota recusada, cancelada, substituída ou excluída que ninguém validou), como na tela |
| `validado_por` | Quem da Contabilidade validou o centro (o nome na hora da validação); vazio sem validação |
| `fornecedor` | Fornecedor lido da nota pela IA (pode estar errado); vazio quando a IA não leu |
| `numero_nf` | Número da nota lido pela IA; vazio quando a IA não leu |
| `valor` | Valor total lido pela IA, com vírgula nos centavos e sem símbolo nem ponto (`1234,56`); vazio quando a IA não leu |
| `chave_acesso` | Chaves de acesso guardadas da nota (a própria de cada página do arquivo e, no escaneado, a que a IA leu), escritas **como no DANFE, em grupos de 4 números separados por espaço** (`2924 1012 …`): 44 números seguidos o Excel lê como número (`2,92E+43`) e perde o final. Várias chaves ficam separadas por ` / `; vazio quando não há |
| `possivel_duplicada` | `sim` quando outra nota viva tem uma chave em comum ou o mesmo arquivo; vazio nos demais. Só vem preenchida na planilha do Financeiro, da Contabilidade e do admin |

As colunas `financeiro` e `aprovado_por` (Fase 6), as quatro do centro de custo (Fase 7), as três lidas pela IA e, por
último, `chave_acesso` e `possivel_duplicada` (Fase 8) ficam **no fim**, nesta ordem: as planilhas que já leem as colunas
anteriores continuam funcionando.

**Uma linha por nota (Fase 9).** O cabeçalho não muda. Num envio com várias notas, cada nota tem a sua linha, com `id` e
`link` do envio, e o `titulo` ganha a posição: `Compra de peças · nota 2 de 3`. Com uma nota, o título é o de sempre. O
limite de 10.000 conta linhas de nota. Boletos e outros arquivos não têm linha.

**Para a contabilidade: não lance as linhas com `financeiro` = `Substituída`.** Elas são versões que o Financeiro
substituiu ao trocar a conta ou que a Contabilidade substituiu ao corrigir o centro de custo (a mesma nota aparece de
novo na linha da nova versão, com a conta ou o centro certo). Uma versão substituída pode aparecer como `Concluído`
quando a troca ou a correção foi feita depois da conclusão; mesmo assim, vale a linha da nova versão.

**Nova versão recusada.** Se alguém que assina recusa a nova versão, não há uma terceira: a versão anterior continua
substituída e o link dela, bloqueado. Quem enviou sobe a NF de novo, como um documento novo (escolhe a conta e o centro
de novo). A contabilidade não lança a versão recusada nem a substituída: só a nota que concluir.

Limite: **10.000 linhas** por planilha. Acima disso, a tela avisa "Filtre por período para exportar menos de 10.000
notas." e a planilha não é gerada. Textos que começam com `=`, `+`, `-` ou `@` ganham um `'` na frente, para o Excel não
tratar como fórmula. Isso vale para **todas** as colunas de texto (título, remetente, fornecedor, número da nota…), porque
agora há texto lido de um documento qualquer na planilha.

## 6. Limites

- Só documento detectado (ou confirmado pelo remetente) como NF vai para a IA. Num documento com vários arquivos, só os
  arquivos que são NF vão (e, desde a Fase 9, os boletos que vêm com elas); um contrato junto fica de fora.
- Até 20.000 caracteres de texto por arquivo; PDF escaneado vai cortado nas 5 primeiras páginas (como imagem).
- A IA tem 20 segundos para responder. Se demorar, errar o formato ou sugerir uma conta que não existe (ou está
  inativa), fica "sem sugestão" e o remetente escolhe na lista. Nada trava. Um dado da nota (fornecedor, número, valor
  ou chave) em formato errado só fica vazio: não custa a sugestão da conta.
- Fase 9: a IA lê **cada arquivo** de nota ou de boleto numa chamada só dele (o texto daquele arquivo, ou o PDF dele se
  for escaneado). Limites:
  - **6 chamadas por arquivo** (a automática + 5 "Sugerir de novo" ou "Sim"/"Não");
  - **120 por usuário por hora** e **1.440 por usuário em 24 horas** (o mesmo teto diário de antes, 60 × 24);
  - **20 arquivos por envio** (notas e boletos, pela ordem dos arquivos); os seguintes ficam "sem sugestão" e o remetente
    escolhe a conta na lista.

  Os dois limites por usuário mudam pela variável `NEXT_PRIVATE_REVALLE_RATE_LIMITS`, com as ações
  `revalle.invoice-suggest` (por hora) e `revalle.invoice-suggest-daily` (24 h), no mesmo formato dos outros limites
  (`verificacao.md`). O mesmo arquivo em outro envio não chama a IA de novo (a leitura é guardada por arquivo).
- Até **10 arquivos por envio** (o plano do Documenso deixava 5). Um limite maior posto pelo admin continua valendo.

## 7. Privacidade

- A política de privacidade (`/privacidade`, versão 1, de 16/11/2026) diz: "As notas fiscais enviadas para assinatura,
  e os boletos que vierem junto com elas, são analisados por um serviço de inteligência artificial (Google Gemini) para
  sugerir a conta contábil, ler da nota o fornecedor, o número, o valor e a chave de acesso, e ler do boleto o
  beneficiário, o CNPJ, o valor, o vencimento e a linha digitável."
- E também: "Vai para essa análise apenas o conteúdo da nota fiscal e do boleto que veio com ela (um boleto enviado sem
  nota não é analisado). No texto da nota, números de CPF são mascarados antes do envio; uma nota digitalizada (imagem)
  é enviada como está. Nunca enviamos a data de nascimento nem os dados da verificação de quem assina."
- Na prática: no texto (da nota e do boleto), `123.456.789-09`, `123456789-09` e 11 dígitos logo depois de "CPF",
  "CPF nº" ou "CPF/CNPJ" viram `***.***.***-**`; CNPJ (14 dígitos), a chave de acesso (44) e a linha digitável ficam. Um
  arquivo escaneado (foto ou digitalização) vai como imagem, e o CPF que estiver nele vai junto: não há texto para
  mascarar. Contrato e outros arquivos não vão para a IA.
- O log do servidor registra só o modelo, os tokens, a duração, o resultado, o tipo da leitura (`kind`: nota ou boleto)
  e, quando o Google recusa, o código HTTP (ex.: 429 = cota, 403 = chave, 404 = modelo retirado); nunca o texto da NF ou
  do boleto nem a resposta do Google. Os dados lidos (fornecedor, número, valor, chave, beneficiário, CNPJ, vencimento,
  linha digitável) também não vão para o log.
- A frase de antes ("…apenas para sugerir a conta contábil") ficou curta quando a IA passou a ler também o fornecedor, o
  número, o valor e a chave. O texto foi corrigido (05/11/2026) e ganhou os boletos na Fase 9 (16/11/2026); a **versão
  do termo continua a mesma** (`1`): quem já aceitou não precisa aceitar de novo. O jurídico ainda precisa validar a
  página.
- **Cache das sugestões:** a tabela `RevalleInvoiceSuggestionCache` guarda, por SHA-256 do arquivo, a conta sugerida,
  a confiança, o modelo, o motivo escrito pela IA (que pode citar o nome do fornecedor ou do tomador) e, desde a Fase 8,
  o fornecedor (com o CPF escondido), o número, o valor e a chave de acesso lidos da nota. Não tem prazo
  e não é apagada quando o documento é excluído. Para limpar (as NFs seguintes voltam a chamar a IA):
  `delete from "RevalleInvoiceSuggestionCache";` no banco.
- **Cache dos boletos (Fase 9):** a tabela `RevalleBoletoCache` guarda, por SHA-256 do arquivo, o que a IA leu do boleto
  (beneficiário, CNPJ, valor, vencimento e linha digitável) e o modelo. Mesmas regras: sem prazo, não é apagada com o
  documento; para limpar, `delete from "RevalleBoletoCache";`.
- A chave fica só no servidor (EasyPanel).

## 8. Problemas comuns

- **"Sem sugestão" sempre:** confira na tela de admin se aparece "Gemini configurado". Se aparecer "sem chave", defina
  `GEMINI_API_KEY`. Se a lista de contas estiver vazia, não há o que sugerir.
- **A NF não foi reconhecida:** o RevSign procura sinais de NF no texto (DANFE, chave de acesso, NFS-e etc.). PDF
  escaneado sem texto gera a pergunta "Este documento é uma nota fiscal?"; num documento escaneado comum, basta
  responder "Não" para enviar. Um documento comum com texto nunca é bloqueado.
- **A contabilidade não recebeu o PDF por e-mail:** o RevSign não manda esse e-mail. A nota está em **Notas fiscais**
  (e na planilha) assim que é enviada; confira se a situação é **Concluída** (todos assinaram e o Financeiro aprovou).

## 9. Financeiro (Fase 6)

Toda nota fiscal passa pelo **Financeiro** antes de ser concluída: alguém do Financeiro **aprova** a conta escolhida ou
**troca** a conta, com o motivo. NFs concluídas antes da Fase 6 ficam como estão.

### Quem é do Financeiro

O administrador marca em **Admin → Perfis** (na Fase 6 a tela se chamava Admin → Financeiro; o endereço antigo leva
para a nova): busque a pessoa pelo nome ou e-mail e ligue **Financeiro** (vale na hora; desligar tira o acesso na
hora). Não há e-mail para o Financeiro: as notas aguardando aprovação ficam em **Notas fiscais**, no filtro
**Aguardando o Financeiro**, e o menu mostra o contador delas (seção 5). Se não houver ninguém marcado e houver NF
esperando, a tela do admin mostra um alerta.

### O que o Financeiro vê

- Em **Notas fiscais**, **todas** as NFs, começando pelo filtro **Aguardando o Financeiro**.
- Clicando no título, a **página da NF**, só de leitura: o PDF (com o botão **Baixar PDF**, que baixa o arquivo; depois
  de concluída, com `_signed` no nome), o título, o remetente, quem assina e a situação de cada um, as versões (link
  para a anterior e a nova, quando houver) e o cartão **Financeiro**, com:
  - a conta atual e a situação;
  - o centro de custo, só de leitura (quem corrige é a Contabilidade);
  - quem escolheu a conta e quando;
  - a sugestão da IA (com a confiança e o motivo);
  - quem aprovou, quando já foi aprovada.
- Quem não é do Financeiro nem da Contabilidade também abre a página da NF em que está envolvido (enviou ou assina),
  sem o cartão, e vê a conta e o centro de custo. Quem não é de nenhum dos dois perfis e não está na NF recebe "Nota
  fiscal não encontrada".

### Contabilidade (Fase 7)

Terceiro perfil, ao lado do Financeiro. Todo mundo é **colaborador** (envia e assina); **Financeiro** e
**Contabilidade** são colaborador mais as funções próprias. O administrador liga **Contabilidade** na mesma tela, **Admin
→ Perfis**: uma linha por pessoa e um interruptor por perfil. A mesma pessoa pode ter os dois, e cada interruptor vale na
hora. Se ninguém estiver na Contabilidade **e houver nota esperando a validação**, a tela do admin mostra um aviso com
o número delas (o mesmo do contador da Contabilidade no menu).

- A Contabilidade vê **todas** as NFs, como o Financeiro: na lista **Notas fiscais**, na **página da NF**, no PDF e na
  planilha. Desligada, perde tudo na hora (a página da NF volta a dar "Nota fiscal não encontrada"). Ela não vê o
  rascunho comum de outra pessoa, como o Financeiro.
- Ela **não aprova nem troca a conta**: essas ações (`revalle.finance.approve`, `changeAccount`) são só do Financeiro e
  respondem **403** à Contabilidade. Na página da NF ela vê a conta como quem não é do Financeiro, mais o cartão
  **Contabilidade**. **Enviar de novo** (`resendVersion`) vale para os dois perfis.
- Ela continua enviando e assinando como qualquer colaborador.
- O administrador só age aqui se também estiver marcado como Contabilidade: sem a marca, as ações respondem **403**.

**Passo a passo da Contabilidade, sem e-mail.** O RevSign não manda e-mail para a Contabilidade. O aviso é o contador:

1. Entre no RevSign. O número ao lado de **Notas fiscais**, no menu, diz quantas notas esperam você (atualiza a cada minuto).
2. Abra **Notas fiscais**. A página abre em **Aguardando a Contabilidade**.
3. Clique no título da nota. Confira o PDF na página da NF e o centro de custo no cartão **Contabilidade**.
4. Centro certo: clique em **Validar centro de custo** e confirme. A nota sai da sua fila.
5. Centro errado: clique em **Corrigir centro de custo**, escolha o centro certo e escreva o motivo. Todos assinam de novo
   a nova versão: eles recebem o aviso e o convite por e-mail, você não.
6. Para lançar a nota: com ela concluída, clique em **Baixar PDF** na página da NF, ou exporte a planilha em **Notas
   fiscais** (não lance as linhas com `financeiro` = `Substituída`).

**Cartão Contabilidade.** Só para quem é do perfil. Mostra o centro de custo e a situação: **Aguardando validação**,
**Validado por {nome} em {data}**, **Sem centro de custo** ou **Sem validação** (nota recusada, cancelada ou substituída
que ninguém validou).

- **Validar centro de custo** (pede confirmação): a qualquer momento depois do envio, antes ou depois do Financeiro.
  Grava quem e quando. Repetir não faz nada. A validação **não segura a conclusão**: a NF conclui quando todos assinam e
  o Financeiro aprova, validada ou não. O certificado e o `/verificar` não falam dela.
- **Corrigir centro de custo**: escolha o centro certo e escreva o **motivo** (de 10 a 500 caracteres). O diálogo avisa
  "Todos vão precisar assinar de novo.". Funciona como a troca de conta, inclusive depois de concluída, e não existe
  "rejeitar":
  - a versão atual vira **Substituída**; quem abrir o link antigo vê "Este documento foi substituído por uma nova
    versão.". Se ela já estava concluída, continua concluída;
  - sai uma **nova versão** (" (v2)", " (v3)"…), com a mesma conta, a mesma situação no Financeiro (se já estava aprovada,
    continua aprovada, com os mesmos nomes, e conclui sem nova aprovação; se aguardava, continua aguardando), o centro
    novo e já validada por quem corrigiu;
  - a exceção é a NF `LEGACY` concluída: corrigida, ela passa a aguardar o Financeiro na nova versão, como qualquer envio;
  - o remetente e quem assina recebem o aviso "Centro de custo da nota fiscal corrigido pela Contabilidade: {título}",
    com a frase "O centro de custo foi corrigido de 101 – Puxada para 201 – Armazém. Motivo: {motivo}.";
  - uma NF sem centro não tem o que corrigir: a tela oferece **Definir centro de custo**.
- **Definir centro de custo** (NF enviada sem centro, marcada depois do envio ou de antes da Fase 7): grava e valida no
  mesmo ato, sem nova versão, porque ninguém viu centro ao assinar. Com centro já escolhido, a tela não oferece e o
  servidor recusa.
- **Enviar de novo**: nova versão cujo envio falhou. Ver "Enviar de novo" abaixo.
- Na versão substituída, o cartão é só de leitura, com o motivo e o link **Abrir a nova versão**. Se a nova versão foi
  apagada (ou a correção parou no meio e passaram 5 minutos), ele diz "A nova versão não existe mais: corrija o centro
  de custo de novo." e volta a mostrar **Corrigir centro de custo**.

**Quem mudou o quê na nova versão:**

| Quem mudou | Conta | Situação no Financeiro | Centro | Validação |
|---|---|---|---|---|
| Financeiro trocou a conta | a nova | aprovada por quem trocou | o mesmo | a mesma da anterior |
| Contabilidade corrigiu o centro | a mesma | a mesma da anterior, com os nomes (NF `LEGACY`: aguardando aprovação) | o novo | validado por quem corrigiu |
| Envio com 2+ notas (conta ou centro de uma nota) | a nova só na nota que mudou | **todas as notas aguardam o Financeiro** | o novo só na nota corrigida | as mesmas; a nota corrigida, validada por quem corrigiu |

Financeiro e Contabilidade agindo ao mesmo tempo: um vence, nunca há duas novas versões, e o outro recebe "A situação
desta nota mudou. Atualize a página e tente de novo." (ou "Esta versão da nota fiscal já foi substituída", se a nova versão
já saiu).
- Pela API: `revalle.accounting.me` devolve `{ isMember }`; `revalle.accounting.adminSetMember({ userId, isMember })` é só
  do administrador (sem sessão **401**, usuário comum **403**). `revalle.finance.adminListUsers` devolve, por pessoa,
  `isFinanceMember` e `isAccountingMember`, e `accountingPendingCount` (notas esperando a Contabilidade).
  `revalle.invoice.pendingCounts` (sessão) devolve `{ finance, accounting }`, o número de cada fila ou `null` quando a
  pessoa não é do perfil; é o que o contador do menu lê.

**Botão View.** Depois que a pessoa assina, o botão **View** das listas deixa de ficar inativo (a nota fiscal pode esperar
dias o Financeiro). Em **Documentos**, quem tem o documento no próprio time abre a página do documento; quem só recebeu
abre a página de conclusão. Na **Caixa de entrada**, abre sempre a página de conclusão. Enquanto o documento não
conclui, essa página tem o botão **Ver documento**, que abre o PDF de cada arquivo em nova aba (com o link do próprio
destinatário). Numa versão substituída, o PDF não abre e a página mostra o aviso da nova versão. Quem é só copiado (CC)
continua sem o botão até o documento concluir.

### Aprovar

Botão **Aprovar conta** (pede confirmação). A NF fica aprovada e:

- se todos já assinaram, o documento é selado na hora;
- se ainda falta alguém, ele é concluído normalmente quando o último assinar;
- se a NF foi marcada como nota fiscal depois de concluída, só a aprovação é gravada: não há o que selar.

Quem é do Financeiro pode aprovar uma NF que ele mesmo enviou ou assina; o log de auditoria e o certificado registram
quem aprovou.

**Envio com várias notas (Fase 9).** A página da NF mostra uma seção por nota ("Nota 2 de 3 · nf-b.pdf"; a lista leva
até ela por `#nota-…`), com a conta, o centro, o que a IA leu, as duplicadas daquela nota e os cartões do Financeiro e
da Contabilidade dela. O Financeiro aprova nota a nota; o envio só é concluído (e selado) quando a última nota for
aprovada e todos tiverem assinado. Aprovar de novo a mesma nota não faz nada. A Contabilidade valida e corrige o centro
nota a nota; nota sem validação não segura a conclusão. Trocar a conta ou corrigir o centro de UMA nota cria a nova
versão do envio inteiro (todos assinam de novo) e **todas as notas voltam a aguardar o Financeiro** (seção 10). O aviso
diz a nota ("A conta contábil da nota fiscal {título} (nota 2 de 3: nf-b.pdf) foi alterada pelo Financeiro de … para
….", "O centro de custo da nota 3 de 3 (nf-c.pdf) foi corrigido de … para …."). O cartão "Boletos do envio" mostra o
que foi lido de cada boleto e os avisos da conferência (Financeiro, Contabilidade, admin e dono; quem só assina não vê
os avisos).

**NF marcada depois do envio, ainda sem conta.** O cartão mostra a lista de contas e o botão **Definir e aprovar**
(pede confirmação): a conta escolhida fica aprovada na hora, sem nova versão e sem ninguém assinar de novo (ninguém viu
conta ao assinar). Depois segue como na aprovação acima.

### Trocar a conta

Botão **Trocar conta** (com a NF aguardando aprovação, aprovada ou já concluída): escolha a nova conta na lista e
escreva o **motivo** (de 10 a 500 caracteres; o contador mostra quantos já foram). Antes de trocar, a tela confirma:
"Todos vão assinar de novo uma nova versão."

- A versão atual vira **Substituída** e não pode mais ser assinada: quem abrir o link antigo vê "Este documento foi
  substituído por uma nova versão.". Se ela já estava concluída, continua concluída.
- O RevSign cria uma **nova versão** (mesmo PDF, mesmas pessoas e campos, título com " (v2)", " (v3)"…), já com a
  conta nova aprovada, o mesmo centro e a mesma validação, e envia na hora. A tela abre a página da nova versão.
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

### Enviar de novo

Quando a troca de conta ou a correção do centro criou a nova versão mas o envio dela falhou, a nova versão fica como
rascunho, e os cartões do Financeiro e da Contabilidade mostram o botão **Enviar de novo** (pede confirmação): o RevSign
envia o documento em nome do dono, com a mesma conta e o mesmo centro. Numa correção do centro, o rascunho fica como foi
criado, aprovado ou aguardando aprovação, e o reenvio não mexe na aprovação copiada. O remetente não troca a conta nem o
centro desse rascunho: ele corrige o que impediu o envio e envia, ou troca o arquivo, e aí a nota volta a ser um rascunho
comum dele, que escolhe a conta e o centro de novo (a aprovação e a validação caem). Só a nova versão tem esse botão; uma
NF comum em rascunho é do remetente. Se aparecer "Envio em andamento. Aguarde um instante.", outra pessoa do Financeiro acabou de enviar: espere e atualize (um
envio que parou no meio pode ser retomado depois de 5 minutos). Se aparecer "O remetente trocou o arquivo; a nota voltou
para ele.", o remetente substituiu o PDF do rascunho enquanto isso: a NF voltou a ser um rascunho dele, que escolhe a
conta de novo.

### E-mail da nova versão

| E-mail | Quando sai | Para quem | Botão |
|---|---|---|---|
| "Conta contábil da nota fiscal alterada pelo Financeiro: {título}" | A nova versão de uma troca de conta foi enviada | O remetente e quem assina, das duas versões | **Assinar a nova versão** (quem assina), **Abrir a nova versão** (remetente) ou **Verificar um documento** (os demais) |
| "Centro de custo da nota fiscal corrigido pela Contabilidade: {título}" | A nova versão de uma correção do centro foi enviada | Os mesmos | Os mesmos |

Ele sai uma vez por pessoa, porque quem assina pode não ter conta no RevSign. O RevSign não manda e-mail pedindo a
aprovação do Financeiro nem avisando a contabilidade: as notas ficam em **Notas fiscais**.

### Documentos não selados (admin)

Em **Admin → Documentos não selados**, uma NF com todos assinados que espera a aprovação aparece com a marca
**Aguardando o Financeiro**, e uma versão substituída com **Versão substituída**. Não estão travadas: não precisa
resselar. A coluna **Parado há** fica vazia para elas.

Resselar (no painel do admin) uma NF **já concluída** que ainda espera a aprovação (marcada como NF depois da conclusão)
refaz o PDF selado normalmente; a aprovação continua pendente. Uma NF ainda pendente que espera a aprovação não é selada pela reselagem: quem a libera é a aprovação.


## 10. Várias notas e boletos no mesmo envio (Fase 9)

Um envio pode ter várias notas fiscais, boletos e outros arquivos (um contrato, um relatório), até 10 arquivos (seção 6).
Cada nota é tratada como uma nota; envios de uma nota só continuam **exatamente como antes**.

**O que cada arquivo é.** O RevSign lê o texto de cada arquivo (sem IA) e o classifica:

- **nota fiscal** (NF-e, NFS-e, CT-e e similares), pelos mesmos sinais de sempre (DANFE, chave de acesso, NFS-e etc.);
- **boleto**, por uma linha digitável válida (os 47 números, com os dígitos conferidos) ou por pelo menos três marcas de
  boleto, uma delas exclusiva de boleto ("linha digitável", "ficha de compensação", "recibo do pagador/sacado", "nosso
  número"). Um contrato que só fala de vencimento, beneficiário e local de pagamento **não** é boleto;
- **outro** (documento comum): não vai para a IA, não tem conta nem linha na lista;
- **sem texto** (escaneado): o remetente responde "Este arquivo é:" **Nota fiscal**, **Boleto** ou **Outro documento**
  (seção 4). O remetente também corrige o tipo de qualquer arquivo pelo mesmo seletor, e **Não é nota fiscal** num bloco
  de nota faz dele documento comum. "É nota fiscal" num boleto não o transforma em nota.

**Uma chamada à IA por arquivo.** Cada nota vai sozinha para a IA (só o texto dela), com a sugestão de conta e os dados
lidos daquela nota; cada boleto também, para ler o beneficiário e o CNPJ. Custo: cerca de US$ 0,004 por nota e por
boleto. Os limites estão na seção 6.

**Cada nota é uma nota.** Conta e centro de custo (seção 4), aprovação do Financeiro e validação da Contabilidade
(seção 9), linha na lista e na planilha (seção 5), alerta de duplicada ("Alerta de nota duplicada"), texto azul no PDF
final, no bloco dela ("A conta e o centro de custo no PDF final") e, na prova, no certificado e no `/verificar`, uma linha ou um quadro
por nota (`prova.md`). O envio só sai com conta e centro em todas as notas e só conclui quando todas forem aprovadas.

### Boleto junto com as notas

- **Só é lido quando o envio tem pelo menos uma nota.** Um boleto sozinho segue como documento comum, sem IA e sem custo.
- **O que é lido:** o valor e o vencimento saem primeiro da linha digitável, no próprio RevSign, sem IA (quando a linha
  existe, ela vale mais que a IA); a IA completa o beneficiário e o CNPJ. O CNPJ do emitente de cada nota sai da chave de
  acesso dela. A leitura é guardada por arquivo (`RevalleBoletoCache`): o mesmo boleto em outro envio não chama a IA.
- **A conferência com as notas é só aviso** (como a nota duplicada): nunca trava o envio, a aprovação nem a conclusão.
  Os três avisos:
  - "O valor do boleto (R$ 1.499,00) não bate com nenhuma nota do envio." O valor bate quando o boleto é igual ao de
    alguma nota ou à soma das notas, ou quando a soma dos boletos do envio (parcelas) é igual a uma nota ou à soma;
  - "O beneficiário do boleto é diferente do emitente das notas." Compara a raiz do CNPJ (os 8 primeiros números, a
    filial é a mesma empresa) quando os dois lados têm CNPJ; senão, o nome (um contém o outro). Sem dado dos dois lados,
    não avisa;
  - "Boleto vencido em 01/11/2026." (vencimento antes de hoje, no horário de Brasília).
- **Onde aparece:** no diálogo de envio (seção 4) e, depois do envio, no cartão "Boletos do envio" da página da NF
  (seção 9).
- **Limite: um PDF com o DANFE e o boleto juntos é nota.** É comum o fornecedor mandar assim: o arquivo vai para a IA
  como nota (uma chamada) e o boleto dentro dele **não** é lido nem conferido. Para conferir o boleto, envie-o como um
  arquivo separado.

### Nova versão com várias notas

Trocar a conta (Financeiro) ou corrigir o centro (Contabilidade) de **uma** nota cria a nova versão do **envio inteiro**,
que todos assinam de novo, e **todas as notas voltam a aguardar o Financeiro**, inclusive a que mudou. As contas, os
centros e as validações das outras notas ficam; só a aprovação reabre ("Quem mudou o quê", seção 9). Decisão do Enzo
(16/11/2026). Com **uma nota só**, vale a regra de antes: a troca de conta sai aprovada por quem trocou e a correção do
centro mantém a aprovação.

### Pela API

- As rotas da nota recebem o arquivo da nota, `envelopeItemId` (opcional): `revalle.invoice.{setChoice,setCostCenter,
  resuggest,markAsInvoice}`, `revalle.finance.{approve,changeAccount,get}` e `revalle.accounting.{validate,defineCostCenter,
  changeCostCenter,get}`. Sem ele, valem quando o envio tem uma nota só; com duas ou mais notas, respondem
  `400 INVOICE_FILE_REQUIRED`. Um arquivo que não é nota do envio (um boleto, ou arquivo de outro envio) dá **404**.
- Rota nova `revalle.invoice.setFileKind({ envelopeId, envelopeItemId, kind })`, com `kind` `NF`, `BOLETO` ou `OTHER`:
  o tipo do arquivo dito pelo remetente.
- As respostas só ganham campos: `documents` (um por arquivo, com `kind`, `position` "nota 2 de 3", a sugestão, os
  dados lidos, a conta, o centro, a situação no Financeiro, `boleto` com os dados e os avisos, duplicadas) e, na lista,
  `envelopeItemId`, `position` e `documentTitle`. Com uma nota, os campos de cima são os de hoje; com duas ou mais, os
  de cima que são de uma nota (conta, sugestão, dados lidos) vêm vazios.
- Envios de nota de antes da Fase 9 com vários arquivos são refeitos sozinhos (na subida do app e na primeira leitura),
  com a nota no primeiro arquivo que o texto reconhece como NF (`deploy.md`, "Antes de atualizar (Fase 9)").
