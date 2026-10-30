# RevSign — notas fiscais e conta contábil (Fase 5)

Guia para o Enzo e para a TI. Explica como configurar a sugestão de conta contábil, o que o remetente vê, a página
**Notas fiscais** e a planilha exportada.

## Como funciona, em uma frase

Quando alguém envia uma nota fiscal (NF) para assinatura, o RevSign percebe que é uma NF, pede ao Gemini (Google) uma
sugestão de conta contábil e obriga o remetente a escolher a conta (ou "Deixar para a contabilidade decidir") antes de
enviar. Quando todos assinam, a contabilidade recebe o PDF assinado por e-mail.

- A conta **não** entra no PDF assinado, no carimbo nem no certificado. Ela pode ser trocada depois sem mexer na prova.
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
   a contabilidade decidir**.
3. O botão **Enviar** só libera depois da escolha.
4. Se o RevSign não tiver certeza (PDF escaneado, sem texto), pergunta "Este documento é uma nota fiscal?". Com "Sim",
   o PDF vai para a IA; com "Não", o documento segue como um documento comum. Se o RevSign errou e não é NF, há o botão
   **Não é nota fiscal**.
5. Depois do envio, a página do documento mostra o cartão **Conta contábil**, onde o dono (ou o admin) troca a conta.
   Cada troca fica no histórico do documento (não no PDF).
6. No menu, **Notas fiscais** lista as NFs que ele enviou ou que chegaram para ele assinar.

**NF enviada pela API ou por modelo:** o documento é criado, mas o envio é recusado (`INVOICE_ACCOUNT_REQUIRED`) até a
conta ser escolhida na tela. O documento fica como rascunho: abra-o no site, escolha a conta e envie. Usar modelo com
"enviar" e envio em lote fazem o mesmo. Detalhes em `deploy.md`, seção "Notas fiscais enviadas pela API ou por modelo".

## 5. Página "Notas fiscais" e planilha

No menu do site, **Notas fiscais**. Cada pessoa vê as NFs já enviadas em que está envolvida: as que enviou e as que
chegaram para ela assinar. O **administrador vê todas**. Rascunhos e documentos apagados não aparecem.

Colunas: título, remetente, data de envio, status, conta (número · nome, ou "A definir pela contabilidade") e
"Sugestão aceita?" (Sim, Não ou "sem sugestão", quando não havia sugestão na hora da escolha).

Filtros: período de envio (dias no horário de Brasília), status, número da conta e "Só as deixadas para a
contabilidade".

**Exportar planilha** baixa `notas-fiscais-AAAA-MM-DD.csv` (data de hoje em Brasília) com os **mesmos filtros** da tela.
O arquivo abre direto no Excel (separador `;`, UTF-8 com BOM). Colunas:

| Coluna | O que é |
|---|---|
| `id` | Identificador do documento no RevSign |
| `titulo` | Título do documento |
| `remetente` | Nome de quem enviou (ou o e-mail, se não tiver nome) |
| `enviado_em` | Data e hora do envio (Brasília, `dd/mm/aaaa hh:mm`) |
| `concluido_em` | Data e hora em que todos assinaram (vazio se ainda não concluiu) |
| `status` | Pendente, Concluído, Recusado ou Cancelado |
| `conta` | Número da conta, ou `a definir pela contabilidade` |
| `nome_conta` | Nome da conta (vazio quando ficou para a contabilidade) |
| `tipo` | `pagar`, `receber` ou vazio |
| `sugestao_ia` | Número da conta que a IA sugeriu (vazio se não houve sugestão) |
| `confianca` | Confiança da IA: `alta`, `media` ou `baixa` (vazio sem sugestão) |
| `aceitou_sugestao` | `sim`, `não`, ou vazio quando não havia sugestão |
| `link` | Endereço do documento no RevSign para quem exportou (dono: página do documento; admin: painel do admin) |

Limite: **10.000 linhas** por planilha. Acima disso, a tela avisa "Filtre por período para exportar menos de 10.000
notas." e a planilha não é gerada. Textos que começam com `=`, `+`, `-` ou `@` ganham um `'` na frente, para o Excel não
tratar como fórmula.

## 6. Limites

- Só documento detectado (ou confirmado pelo remetente) como NF vai para a IA. Num documento com vários arquivos, só os
  arquivos que são NF vão; um contrato junto fica de fora.
- Até 20.000 caracteres de texto por arquivo; PDF escaneado vai cortado nas 5 primeiras páginas.
- A IA tem 20 segundos para responder. Se demorar, errar o formato ou sugerir uma conta que não existe (ou está
  inativa), fica "sem sugestão" e o remetente escolhe na lista. Nada trava.
- 60 sugestões por usuário por hora, e no máximo 6 chamadas à IA por documento (a automática + 5 "Sugerir de novo" ou
  "Sim"/"Não").

## 7. Privacidade

- A política de privacidade (`/privacidade`) diz: "As notas fiscais enviadas para assinatura são analisadas por um
  serviço de inteligência artificial (Google Gemini) apenas para sugerir a conta contábil."
- Nunca vão para o Gemini: CPF (números com cara de CPF são mascarados no texto), data de nascimento e os dados da
  verificação de quem assina.
- O log do servidor registra só o modelo, os tokens, a duração e o resultado; nunca o texto da NF.
- A chave fica só no servidor (EasyPanel).

## 8. Problemas comuns

- **"Sem sugestão" sempre:** confira na tela de admin se aparece "Gemini configurado". Se aparecer "sem chave", defina
  `GEMINI_API_KEY`. Se a lista de contas estiver vazia, não há o que sugerir.
- **A NF não foi reconhecida:** o RevSign procura sinais de NF no texto (DANFE, chave de acesso, NFS-e etc.). PDF
  escaneado sem texto gera a pergunta "Este documento é uma nota fiscal?". Um documento comum nunca é bloqueado.
- **A contabilidade não recebeu o e-mail:** confira o campo na tela de admin e se a NF está **Concluída** (todos
  assinaram). O e-mail sai uma vez só; reselar o documento não reenvia.
