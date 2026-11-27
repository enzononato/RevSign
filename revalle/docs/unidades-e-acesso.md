# Unidades, times e acesso (v.26)

Para quem: TI e administradores do RevSign. Explica como organizar as pessoas por unidade e por setor, quem vê o quê,
a inativação pela folha e o app autenticador na assinatura. O deploy da versão está em `deploy.md`, seção "Antes de
atualizar (unidades, times e acesso, v.26)".

## Primeiros passos depois de atualizar

Faça logo depois do deploy, como admin. Até o passo 4, o Financeiro e a Contabilidade não veem nota nenhuma nas filas.

1. Abra **Admin → Unidades e times** e clique em **Criar as 7 unidades**.
2. Abra cada unidade e confira os times. Se a base do RH não respondeu, clique em **Criar times a partir dos setores
   do RH**.
3. Em cada unidade, clique em **Adicionar pessoa** e marque os times de cada pessoa. Comece por quem envia notas.
4. Na lista de unidades, seção **Financeiro e Contabilidade**, clique em **Escolher unidades** para cada pessoa.
   Ninguém pode ficar com "Sem unidades: escolha as unidades desta pessoa".
5. Ligue **Ver só o que enviou ou recebeu para assinar** para quem não deve ver os documentos dos colegas do time.
6. Avise quem envia notas: a nota agora sai pelo time da unidade, escolhido no topo da tela.
7. No dia seguinte, abra **Admin → Usuários → Inativados pela folha** e confira quem a rotina da noite desativou.

## O que são unidades e times

- **Unidade** é uma organização marcada como unidade da Revalle. Começam 7: Juazeiro, Bonfim, Petrolina, Ribeira do
  Pombal, Paulo Afonso, Alagoinhas e Serrinha. O admin pode criar outras.
- **Time** é um setor da unidade (Administrativo, Logística…). Os documentos ficam no time pelo qual foram enviados.
- Cada pessoa vê os documentos dos times dela. Quem não está em nenhum time da unidade não vê documento da unidade.
- O **espaço pessoal** continua existindo. Os documentos antigos ficam onde estão.
- O admin do sistema vê tudo.

O painel fica em **Admin → Unidades e times**. Só o admin abre.

## Criar as unidades

### Criar as 7 unidades

Na primeira vez a lista está vazia e mostra o botão **Criar as 7 unidades**. Ele cria as 7 de uma vez, cada uma com os
times dos setores do RH. Pode clicar de novo: o que já existe não se repete. Se faltar alguma, o botão vira **Criar as
que faltam (N)**.

Se a base do RH não responder, as unidades são criadas sem times. A tela avisa. Depois use **Criar times a partir dos
setores do RH** em cada unidade.

Quem cria a unidade vira dono dela e administra todos os times. Essa pessoa não pode sair da unidade.

### Outra unidade

Clique em **Nova unidade**. Use o mesmo nome da unidade na base do RH, para os times virem dos setores dela.

O nome na base do RH fica gravado na criação e aparece na unidade ("Nome na base do RH: …"). **Renomear** muda só o
nome que aparece; o nome na base do RH continua o mesmo. Se a unidade foi criada com o nome errado, ela não acha os
setores: apague a organização em **Admin → Organizações** e crie de novo.

### Como o nome da unidade do RH bate

A coluna `unidade` da base do RH bate com a unidade do RevSign quando, sem acento e sem maiúsculas:

- o nome é igual, ou
- termina com o nome da unidade, como palavra inteira.

Exemplos: "Senhor do Bonfim" é a unidade **Bonfim**. "Juazeiro do Norte" **não** é **Juazeiro**.

## Criar times a partir dos setores do RH

Abra a unidade e clique em **Criar times a partir dos setores do RH**. O RevSign lê na base do RH (só leitura) os
setores distintos dessa unidade e cria um time por setor.

- Time que já existe (mesmo nome, sem acento nem maiúsculas) não se repete. Pode clicar de novo depois que o RH criar
  um setor.
- Setor que só tem pessoas desligadas não vira time.
- Se a tela disser que a base do RH não tem setores para a unidade, confira o nome da unidade no RH.

Também dá para criar um time à mão (**Novo time**), **Renomear** e **Remover**.

- Renomear muda só o nome. O endereço do time continua o mesmo.
- Só dá para remover time **sem documentos**. As pessoas saem do time, continuam na unidade e recebem um e-mail
  avisando. Não dá para desfazer.

## Pôr pessoas e escolher os papéis

1. Na unidade, clique em **Adicionar pessoa**.
2. Busque pelo nome ou e-mail. Só aparece quem já tem conta. Quem não tem precisa criar a conta antes.
3. Marque os times da pessoa (um ou mais) e o papel em cada um.
4. Clique em **Adicionar**.

A pessoa não recebe e-mail. Conta desativada não pode entrar: reative antes.

Papéis no time:

- **Membro** (padrão): envia e assina. Vê os documentos do time.
- **Gerente**: também gerencia o time. Token de API continua só com o administrador do sistema, e ele precisa ser
  gerente (ou administrador) do time para criar o token daquele time.
- **Administrador**: aparece só para leitura. O painel não muda esse papel.

Para mudar os times de alguém, clique na pessoa e salve os times. Quem fica no mesmo time mantém o papel. Desmarcar um
time tira a pessoa dele.

**Tirar da unidade** tira a pessoa da unidade e de todos os times dela. Os documentos que ela enviou ou recebeu para
assinar continuam com ela.

Depois que o TI muda a unidade de alguém, a pessoa precisa recarregar a página para o menu e os avisos mudarem.

### Onde o envio abre

O menu **Documentos** e a tela depois do login abrem no último time que a pessoa usou. Se esse time for o espaço
pessoal, ou se não houver nenhum, abrem no primeiro time da unidade dela.

## Ver só o que enviou ou recebeu para assinar

Por pessoa, o TI liga **Ver só o que enviou ou recebeu para assinar**. O botão fica na pessoa dentro da unidade. Vale
para a pessoa em todos os times, não só naquela unidade.

Com a marca ligada, em qualquer time, a pessoa só vê os documentos que ela enviou ou em que é destinatária. A regra
vale no servidor:

- lista, contadores, busca e contagem das pastas;
- abrir o documento e baixar os arquivos;
- sugestões de destinatário;
- API v1 e v2 (documento de colega dá 404).

O que não muda:

- os modelos do time continuam visíveis para todos do time;
- os números do painel do time (só gerente e administrador do time veem) continuam contando o time todo;
- o admin do sistema nunca é limitado, mesmo com a marca.

## Financeiro e Contabilidade: as unidades de cada pessoa

Quem é do Financeiro ou da Contabilidade (marcado em **Admin → Perfis**) só vê e age nas notas fiscais das unidades
escolhidas para ela. A unidade da nota é a unidade do time pelo qual a nota foi enviada.

Onde escolher: **Admin → Unidades e times**, seção **Financeiro e Contabilidade** (ou na pessoa, dentro da unidade).
Clique em **Escolher unidades**, marque as unidades e **Salvar unidades**.

A regra vale em:

- a página **Notas fiscais**, as filas e os contadores do menu;
- a planilha;
- a página da nota e o PDF;
- aprovar, trocar a conta, validar e corrigir o centro de custo.

Nota de outra unidade dá 404.

**Sem unidades:** quem é do Financeiro ou da Contabilidade e não tem unidade escolhida não vê nota nenhuma nas filas.
O painel avisa "Sem unidades: escolha as unidades desta pessoa". A pessoa continua vendo as notas que ela mesma enviou
ou assina, como qualquer remetente, mas fora das filas.

O alerta de nota duplicada continua comparando todas as unidades. Se a outra nota for de unidade que a pessoa não
cobre, ela vê só a data, quem enviou e a situação, sem o título e sem o link.

## Nota fiscal só pelo time da unidade

Nota fiscal só sai de um time de unidade. No espaço pessoal, o envio é recusado com:

> Nota fiscal deve ser enviada pelo time da sua unidade. Troque para o time no topo da tela.

- O diálogo de envio mostra o mesmo aviso quando a pessoa escolhe "Nota fiscal" fora de um time de unidade.
- Marcar como nota depois do envio também é recusado fora do time da unidade.
- **Apenas assinar** continua liberado no espaço pessoal.
- A nova versão enviada pelo Financeiro segue a nota original e não é recusada.
- Pela API vale o mesmo: o token precisa ser do time da unidade.

Quem ainda não está em nenhuma unidade não consegue enviar nota. Ponha a pessoa numa unidade antes.

### Notas antigas do espaço pessoal

As notas enviadas pelo espaço pessoal antes da v.26 ficam onde estão. Elas aparecem **só para o admin e para quem
enviou**. O Financeiro e a Contabilidade não veem essas notas. Se uma delas ainda espera aprovação ou validação, o
admin cuida.

## Inativação pela folha (toda noite)

Toda noite, às **03:00**, o RevSign confere na base do RH quem está desligado e **desativa** a conta. Nunca apaga.

- O horário segue o fuso do container. O serviço `revsign` precisa de `TZ=America/Bahia`. Sem ele, roda às 03:00 UTC
  (meia-noite na Bahia).
- Só contas ativas com CPF vinculado ao e-mail. Contas sem CPF vinculado não são tocadas.
- "Desligado" usa a mesma lista de situações da lista de colaboradores ("inativ", "deslig", "demit", "rescis",
  "falecid" e parecidas). Afastado não é desligado.
- CPF com mais de uma linha no RH (readmissão) só é desativado se todas as linhas forem de saída. CPF que não está no
  RH não é tocado.
- A conta desativada perde as sessões abertas. Fica um registro com data e origem "folha", sem CPF no log.
- **Administradores do sistema nunca são desativados pela folha.** Se for o caso, o TI desativa à mão.
- **Base do RH fora do ar** (ou sem `COLABORADORES_DATABASE_URL`): não faz nada naquela noite.

### Trava de segurança

Se numa noite a folha indicaria mais contas do que o teto, **ninguém é desativado**. O log mostra só o código
`REVALLE_HR_SWEEP_CAP_EXCEEDED`.

- Teto padrão: o maior entre 10 e 5% das contas ativas com CPF vinculado.
- `NEXT_PRIVATE_REVALLE_HR_INACTIVATION_MAX` troca o teto por um número fixo (inteiro, `0` ou mais).
- Se a trava disparar, confira a base do RH antes. Se a demissão em massa for real, suba o teto, espere a noite
  seguinte e depois volte ao padrão.

### Na tela de usuários

Em **Admin → Usuários**:

- O botão **Inativados pela folha** mostra só as contas que a rotina desativou.
- **Reativar** libera a conta e liga a marca **Mantido ativo pelo TI**. Fica registrado quem reativou.
- Na página da pessoa aparece o aviso "Inativado pela folha", com **Reativar**, e o interruptor **Mantido ativo pelo
  TI**.
- Com a marca ligada, a rotina não desativa a conta, mesmo que a folha mostre desligado. Desligue a marca e a próxima
  noite volta a conferir.
- O botão de ativar conta do sistema também liga a marca quando quem desativou foi a folha.

## Zerar autenticador

Quando alguém troca de celular e perde o app autenticador:

1. Abra **Admin → Usuários** e a página da pessoa.
2. Clique em **Zerar autenticador** e confirme.

O autenticador da pessoa é desligado e fica registrado quem zerou. A pessoa volta a receber o código por e-mail. Até
recarregar a página, ela pode ainda ver o passo do autenticador: basta clicar em "Prefiro receber o código por e-mail".
Depois ela pode cadastrar o app de novo.

## Autenticador na assinatura

É opcional, por pessoa. Quem não cadastrou continua com o código por e-mail, como antes.

### Como a pessoa liga

1. Na própria conta, abra **Configurações → Segurança**.
2. Em **Autenticação de dois fatores**, clique em **Ativar 2FA** e leia o QR code com um app autenticador (Google
   Authenticator, Microsoft Authenticator ou outro).
3. Guarde os códigos de recuperação.

A tela diz: "O código do app autenticador também confirma as suas assinaturas, no lugar do código enviado por e-mail."

### Na hora de assinar

- Quem está logado na **própria conta** (a do e-mail que recebeu o documento) e tem o autenticador ligado vê "Digite
  o código do seu app autenticador" no lugar do código por e-mail.
- O botão **Prefiro receber o código por e-mail** volta ao código por e-mail.
- Em outra conta, ou sem login, o código do app não vale. Só o código por e-mail.
- Código errado conta tentativa, como o código por e-mail. Na 5ª, o link trava.

### O que fica registrado

O histórico do documento, o comprovante (certificado), a página `/verificar`, a prova e o passo "Assinado" da situação
de envio mostram **"Assinatura confirmada pelo app autenticador"**, com data, hora e usuário.
