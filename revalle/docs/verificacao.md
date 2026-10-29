# RevSign — verificação de identidade de quem assina

Para quem: Enzo (TI) e o time de TI da Revalle.

Resumo: antes de assinar, cada pessoa aceita um termo e, na primeira vez, confirma o CPF e a data de nascimento com a base de colaboradores. Depois disso o sistema "lembra" quem é a pessoa. Ao concluir, o RevSign sempre pede um código enviado por e-mail.

Esta etapa se chama **portão** nos textos técnicos.

O que fica registrado no PDF final (carimbo, certificado) e como conferir um documento pelo código: `prova.md`.

## Como funciona para quem assina

As telas, na ordem em que a pessoa vê:

1. **Termo** ("Antes de assinar"): texto curto sobre a assinatura eletrônica, o link "Política de privacidade" e a caixa "Li e concordo". Botão "Continuar". Aparece em todo documento novo.
2. **CPF e data de nascimento** ("Confirme que é você"): campos "CPF" e "Data de nascimento" (dd/mm/aaaa). Botão "Confirmar".
   - Só aparece na primeira vez de cada pessoa (e-mail ainda sem vínculo).
   - Se os dados estiverem certos, a tela mostra "Você é <primeiro nome>" (com cargo e unidade) e os botões "Sim, sou eu" e "Não sou eu".
   - Se estiverem errados, a mensagem é sempre a mesma: `CPF ou data de nascimento não conferem.` (vale para CPF que não existe na base e para data errada). A tela informa quantas tentativas restam.
3. **Documento**: a pessoa lê o PDF e preenche os campos.
4. **Assinar**: botão de concluir.
5. **Código por e-mail**: botão "Enviar código para meu e-mail", depois o código de 6 dígitos que chega na caixa de entrada.
   - Só esse código conclui a assinatura: nenhum outro meio (autenticador de conta, login) substitui o código enviado ao e-mail do destinatário.
   - O código vale por 5 minutos. Cada código errado ou vencido conta como tentativa: no **5º erro** o link é bloqueado (ver abaixo). Acertar o código zera a contagem.
6. **Concluído**: o documento é selado.

### O que é "vínculo"

Depois da primeira confirmação ("Sim, sou eu"), o sistema guarda a ligação **e-mail ↔ CPF**. Isso é o vínculo. Nos documentos seguintes a pessoa não vê mais a tela de CPF: só o termo, o documento e o código por e-mail.

Se o e-mail da pessoa já constar na base de colaboradores (coluna `email` da view), o vínculo é feito sozinho, sem pedir CPF.

### Quem não passa pelo portão

- Papéis **só visualizar** e **cópia** (CC): não assinam, então não veem termo nem CPF.
- Quem **já assinou** o documento (inclusive antes da Fase 3) abre o documento sem portão.

### Que dados são guardados

| Dado | Guardado? | Onde |
|---|---|---|
| Data de nascimento digitada | **Não.** Só é comparada com a base na hora | em lugar nenhum |
| CPF | Sim, completo, na tabela de vínculos (e-mail ↔ CPF) | banco do RevSign |
| CPF nos registros de auditoria do documento | Só mascarado (`***.456.789-**`); o CPF digitado não vai inteiro para a auditoria | auditoria |
| CPF no certificado anexado ao documento | Só mascarado | PDF final |
| CPF nos logs do sistema | Não é registrado (nenhuma chamada de log do portão recebe o CPF) | — |
| Aceite do termo | Versão, data, IP e navegador | banco do RevSign |
| Código de 6 dígitos | Não é registrado | — |

A página pública `/privacidade` diz o mesmo: o CPF aparece só mascarado na auditoria e no certificado, e o vínculo e-mail ↔ CPF fica no banco.

## Quando um link é bloqueado

O link de assinatura (do destinatário daquele documento) é bloqueado por segurança em três casos:

- **Excesso de tentativas**: 5 erros de CPF ou data de nascimento naquele link.
- **CPF ligado a outro e-mail**: a pessoa digitou um CPF que já está vinculado a outro e-mail (ou que, na base, tem outro e-mail cadastrado). O log de auditoria do documento registra o CPF digitado só mascarado.
- **Excesso de códigos errados**: 5 códigos por e-mail errados ou vencidos na hora de concluir, naquele link.

O que a pessoa vê: "Este link foi bloqueado por segurança. Avisamos quem enviou o documento e o TI. Aguarde o desbloqueio ou peça um novo envio para outro e-mail."

### Quem recebe o aviso

Um e-mail "Link de assinatura bloqueado — <nome do documento>" vai para:

1. quem **enviou** o documento (o remetente);
2. o e-mail de `NEXT_PRIVATE_REVALLE_ADMIN_EMAIL` (se for diferente do remetente).

O e-mail diz o motivo e manda desbloquear em **Admin → Verificações**.

### Como desbloquear

1. Entre no RevSign com uma conta de administrador.
2. Abra `/admin` e clique em **Verificações**.
3. Na lista **Links bloqueados**, ache o documento e o e-mail da pessoa. A coluna de motivo mostra "Excesso de tentativas", "Excesso de códigos errados" ou "CPF ligado a outro e-mail".
4. Se o motivo for **"Excesso de tentativas"** ou **"Excesso de códigos errados"**, vá ao passo 8. No caso dos códigos, confirme antes com a pessoa que foi ela mesma quem errou (se não foi, alguém está tentando assinar com o link dela: não desbloqueie e peça ao remetente um novo envio).
5. Se o motivo for **"CPF ligado a outro e-mail"**, o conflito pode ter duas origens. Olhe abaixo do motivo:
   - aparece **"Vínculo atual: <e-mail>"**: esse CPF já está vinculado àquele e-mail. Na lista **Vínculos de e-mail**, busque por esse e-mail (o mostrado na linha).
   - não aparece nada: não há vínculo desse CPF; o conflito vem da base de RH (ver passo 7).
6. Confirme com a pessoa (ou com o RH) qual e-mail é o correto.
7. **Se existe um vínculo desse CPF com outro e-mail** (o "Vínculo atual" da linha): se o vínculo estiver errado, clique em **Remover vínculo** e confirme. Faça isto ANTES de desbloquear; senão a pessoa tenta de novo e o link bloqueia outra vez. Se o vínculo estiver certo, não desbloqueie: o remetente reenvia o documento para o e-mail do vínculo.
   **Se NÃO existe vínculo** para esse CPF: o conflito vem do e-mail cadastrado na base de RH para esse CPF, que é diferente do e-mail do destinatário. Não há vínculo para remover, e só desbloquear não resolve (o link bloqueia de novo). Escolha uma saída e só depois desbloqueie: (a) o RH corrige o e-mail na base; ou (b) o remetente reenvia o documento para o e-mail que a base tem.
8. Volte à lista **Links bloqueados** e clique em **Desbloquear** na linha do documento.
9. Avise a pessoa para abrir o link de novo. Os contadores (CPF/data e códigos por e-mail) voltam a zero e o evento "Link desbloqueado pelo administrador" fica no log de auditoria.

Trocar o e-mail do destinatário no documento **não desbloqueia** o link (de propósito, por segurança): o bloqueio e as tentativas continuam valendo. Sempre desbloqueie pela tela de Verificações.

Trocar o e-mail do destinatário também gera um **link novo**: o link enviado ao e-mail anterior deixa de abrir (página não encontrada). Reenvie o documento para o e-mail novo. A pessoa nova começa do zero: o aceite do termo e a confirmação de identidade são apagados (ela aceita o termo e confirma de novo). O bloqueio e as tentativas são mantidos.

## Remover um vínculo

Use quando o vínculo foi feito com a pessoa errada, quando alguém troca de e-mail ou para resolver um "CPF ligado a outro e-mail".

1. Entre como administrador e abra **Admin → Verificações**.
2. Em **Vínculos de e-mail**, busque pelo e-mail (campo "Buscar por e-mail"). A lista mostra o e-mail, o nome (quando a base está ligada) e o CPF mascarado.
3. Clique em **Remover vínculo** e confirme em "Remover este vínculo?".

Efeito: vale só para documentos **novos**. Na próxima vez que esse e-mail receber um documento, a pessoa confirma CPF e data de novo. Quem já foi reconhecido ou confirmou naquele documento (que ainda está em andamento) continua passando nele, mesmo com o vínculo removido: o sistema só consulta o vínculo para quem ainda não passou pela identidade no documento. Se o termo mudar de versão, o termo é pedido de novo, mas a identidade já confirmada continua valendo.

## Ligar a base real de colaboradores

Em homologação o RevSign usa uma base fictícia (`revalle/colaboradores/dev-seed.sql`). Para produção, ligue a base real de RH. O RevSign só **lê**, e só uma view chamada `vw_colaboradores_assinatura`; nunca altera a base.

Quem faz: quem administra o banco de RH (TI), com Enzo.

### Parte 1 — Criar a view e o usuário de leitura

1. Abra o arquivo `revalle/colaboradores/criar-view-e-usuario.sql` e salve uma cópia para editar.
2. Peça ao administrador do banco de RH o nome da tabela e das colunas de CPF, nome, nascimento, cargo, setor, unidade, matrícula, e-mail, telefone e situação.
3. Na cópia, troque tudo que está entre `< >` pelos nomes reais.
   - `cpf` precisa ter só dígitos (11 caracteres). O modelo já tira a máscara.
   - `data_nascimento` precisa ser do tipo `date`.
   - `unidade` usa os nomes: Juazeiro, Senhor do Bonfim, Petrolina, Paulo Afonso, Ribeira do Pombal, Serrinha, Alagoinhas.
   - `situacao` é `ativo`, `afastado` ou `desligado`. Não filtre ninguém: desligados e afastados também assinam.
   - `email` pode ser `NULL::text` se a base não tem e-mails.
4. No lugar de `<definir>`, escreva uma senha forte para o usuário `revsign_leitura` e guarde no cofre de senhas.
5. Abra um terminal SQL no banco de RH, como administrador, e rode o bloco da view (item 1 do arquivo).
6. Rode o bloco que cria o usuário e dá permissão só na view (itens 2 e 3 do arquivo).
7. Rode a conferência 3b:
   `SELECT has_table_privilege('public', '<tabela>', 'SELECT') AS publico_pode_ler;`
   - Resultado `f`: certo, siga em frente.
   - Resultado `t`: qualquer usuário do banco lê a tabela, inclusive o `revsign_leitura`. Peça ao dono da tabela para rodar `REVOKE SELECT ON <tabela> FROM PUBLIC;` (antes, veja se outros usuários dependem disso) e rode a conferência de novo.
8. Rode a conferência 3c (devem dar, nesta ordem, `f` e `t`):
   `SELECT has_table_privilege('revsign_leitura', '<tabela>', 'SELECT') AS le_a_tabela;`
   `SELECT has_table_privilege('revsign_leitura', 'vw_colaboradores_assinatura', 'SELECT') AS le_a_view;`
   - Se `le_a_tabela` deu `t`, pare: o usuário enxerga mais do que deveria. Corrija antes de continuar.
9. Conecte-se como `revsign_leitura` e rode `SELECT count(*) FROM vw_colaboradores_assinatura;`. Deve listar pessoas.
10. Ainda como `revsign_leitura`, tente ler a tabela real: deve dar `permission denied`.

### Parte 2 — Configurar no EasyPanel

1. Monte a URL de conexão: `postgres://revsign_leitura:<senha>@<host>:5432/<banco>`.
   - Se a senha tiver caracteres especiais (`@`, `:`, `/`, `#`, `%`), troque-os pelo código com `%` (por exemplo `@` vira `%40`). Para evitar o trabalho, use uma senha só com letras e números.
   - `<host>`: se o Postgres de RH roda na mesma VPS pelo EasyPanel, use o nome interno do serviço, no formato `<projeto>_<serviço-postgres>` (o mesmo padrão do passo 2 do `deploy.md`). Esse nome só funciona de dentro da VPS. Se o banco de RH fica em outro servidor, use o endereço dele e libere o IP da VPS no firewall.
2. No EasyPanel, abra o serviço `revsign` e a aba **Environment**.
3. Crie (ou troque) a linha `COLABORADORES_DATABASE_URL=<a URL do item 1>`.
4. Confira que NÃO existe a linha `NEXT_PRIVATE_REVALLE_IDENTITY_CHECK=disabled`. Sem a variável, vale `required`.
5. Clique em **Save**.
6. Clique em **Restart** (ou **Deploy**) e espere ficar verde.

### Parte 3 — Conferir que funciona

1. Escolha um colaborador real que ainda não assinou nada no RevSign (e que concorde com o teste).
2. Envie um documento de teste para o e-mail corporativo dele.
3. Peça que abra o link, aceite o termo e veja a tela "Confirme que é você". Isso mostra que o e-mail ainda não tem vínculo.
4. Peça que digite o CPF e a data de nascimento e confirme.
5. Esperado: aparece "Você é <primeiro nome>" com cargo e unidade. Isso prova que a leitura da base funciona.
6. Peça que clique em "Sim, sou eu" e conclua a assinatura com o código por e-mail.
7. Em **Admin → Verificações → Vínculos de e-mail**, o e-mail da pessoa aparece com o CPF mascarado e o nome.
8. Se aparecer "Não foi possível confirmar agora", o RevSign não conseguiu ler a base: confira host, usuário, senha e se o firewall deixa a VPS chegar ao banco. O log do serviço `revsign` mostra `base de colaboradores indisponível` (sem dados pessoais).

O RevSign sobe mesmo sem a base. Sem ela, só quem precisa da tela de CPF fica sem poder assinar (aparece "Não foi possível confirmar agora"); quem já tem vínculo assina normalmente.

## Homologação sem a base

Se a base real ainda não está pronta, dá para testar o resto do fluxo:

1. No EasyPanel, serviço `revsign`, aba **Environment**: adicione `NEXT_PRIVATE_REVALLE_IDENTITY_CHECK=disabled`.
2. **Save** e **Restart**.

Efeito: a tela de CPF e data de nascimento é **pulada**. A etapa fica registrada como **não verificada** no estado do destinatário e no log de auditoria do documento ("Verificação de identidade desativada nesta instalação (não verificado)", com IP e navegador), e nenhum vínculo e-mail ↔ CPF é criado. O termo e o código por e-mail continuam obrigatórios.

**Nunca use em produção**: sem a conferência, qualquer pessoa com o link assina sem provar quem é. Para voltar ao normal, apague a linha (ou troque por `required`), salve e reinicie.

## Limites de tentativas e de uso

Os limites do upstream contam por IP, e na Revalle cada unidade inteira sai para a internet por um único IP. Por isso os padrões do RevSign foram ajustados para caber uma unidade toda sem travar o uso normal.

| Ação (nome técnico) | Limite padrão | Por quê |
|---|---|---|
| `auth.signup` | 30 cadastros por hora, por IP | Uma unidade inteira cadastrando gente no mesmo dia. Só e-mails dos domínios da empresa se cadastram |
| `auth.request-2fa-email` | 5 pedidos de código em 15 min por destinatário; 200 por IP | O código por e-mail é pedido a cada conclusão. O teto por destinatário evita abuso; o por IP cabe a unidade toda |
| `auth.login` | 10 tentativas em 15 min por e-mail; 200 por IP | Protege contra adivinhar senha sem travar a unidade |
| `api.trpc` | 3000 por minuto, por IP | A tela faz muitas chamadas internas |
| `api.file-upload` | 300 por minuto, por IP | Envio de arquivos |
| `revalle.gate` (fixo) | 300 por 15 min, por IP | Telas do portão. Não se ajusta por variável |
| `revalle.complete` | 20 tentativas de concluir em 15 min, por link (não por IP) | Freia quem tenta concluir muitas vezes com o mesmo link. Passou do limite, a tela pede para tentar mais tarde |

Além disso, cada link aceita no máximo **5 tentativas** de CPF e data e no máximo **5 códigos por e-mail errados ou vencidos**; no 5º erro de cada um o link é bloqueado (isso não é ajustável).

### Como ajustar

1. No EasyPanel, serviço `revsign`, aba **Environment**.
2. Crie ou edite `NEXT_PRIVATE_REVALLE_RATE_LIMITS`.
3. Formato de cada item: `acao=máximo/janela` ou `acao=máximo:máximoPorIp/janela`. Separe vários itens por vírgula. A janela usa `s`, `m`, `h` ou `d`.
   - Exemplo: `auth.signup=60/1h,auth.login=10:300/15m`
4. O que você escrever troca só aquela ação; as demais mantêm o padrão.
5. **Save** e **Restart**.
6. Itens com erro de formato são ignorados, e o log do serviço mostra `NEXT_PRIVATE_REVALLE_RATE_LIMITS: entradas ignoradas`.

## Termo e política

Os dois são **versões provisórias** e precisam ser **validados pelo jurídico antes da produção**. Isso está marcado na própria tela ("Versão provisória — a validar pelo jurídico.").

- **Termo de assinatura eletrônica**: arquivo `packages/lib/revalle/term.ts`. Versão atual: `1`. O aviso de provisório está em `REVALLE_TERM_NOTICE`.
- **Política de privacidade**: página pública `/privacidade` (arquivo `apps/remix/app/routes/_share+/privacidade.tsx`). Tem campos "[a preencher pela Revalle]" (razão social, CNPJ, endereço e prazo de retenção) que o jurídico precisa completar.

### Como publicar uma nova versão do termo

1. Peça a alteração ao desenvolvedor (o texto fica no código).
2. No arquivo `term.ts`, o desenvolvedor aumenta `REVALLE_TERM_VERSION` (de `'1'` para `'2'`) e troca o texto.
3. Publica uma nova imagem e atualiza o serviço (ver "Atualizar a versão depois" no `deploy.md`).
4. Efeito: quem ainda vai assinar um documento aceita o termo novo de novo. Cada aceite grava versão, data, IP e navegador.
