# RevSign — prova da assinatura: carimbo, certificado e `/verificar`

Para quem: RH, jurídico, auditoria e o time de TI da Revalle. Não precisa saber programar.

Resumo: todo PDF assinado pelo RevSign sai com três provas.

1. Um **carimbo** de texto no lugar de cada assinatura.
2. Um **certificado de assinatura**: páginas anexadas no fim do PDF, com os dados de cada pessoa.
3. A página pública **`/verificar`**: qualquer pessoa digita o código do carimbo e confere o documento.

O PDF final também é **selado** com o certificado digital da Revalle. O selo é o que garante que nada foi alterado depois; ver `certificado.md`.

## 1. O carimbo

Cada campo de assinatura do documento recebe estas 5 linhas:

```
Assinado eletronicamente por FULANO DE TAL DA SILVA
CPF ***.456.789-**
em 29/10/2026 14:32 (horário de Brasília)
Código de verificação: 7KQ2-M9XA
Confira em https://assinatura.revalle.com.br/verificar
```

| Linha | O que é |
|---|---|
| `Assinado eletronicamente por …` | Nome da pessoa, em maiúsculas, como está na base de colaboradores no momento da assinatura |
| `CPF ***.456.789-**` | CPF **mascarado**: só os 6 dígitos do meio aparecem. Se a verificação de identidade estiver desligada, sai `CPF não verificado` |
| `em … (horário de Brasília)` | Data e hora em que a pessoa concluiu a assinatura |
| `Código de verificação` | Código único daquela assinatura (8 letras e números). É o que se digita no `/verificar` |
| `Confira em …/verificar` | Endereço da página de conferência |

- **Desenhar é opcional.** Quem desenha (ou envia uma imagem) tem o desenho ao lado do carimbo. Quem só clica em "Assinar" fica só com o carimbo. As duas formas valem, e o certificado diz qual foi usada.
- Em campo pequeno a letra diminui. No limite, a linha do CPF e a do endereço podem sair; nome, data e código ficam sempre.
- O carimbo é desenhado antes da selagem, então também fica protegido pelo selo.
- Sem logo nem nome do gov.br.

## 2. O certificado de assinatura

Depois das páginas do documento vêm as páginas **"Certificado de Assinatura"** e, depois delas, o log de auditoria (a lista de eventos).

No topo de cada página do certificado:

- `Horários em horário de Brasília (UTC−3)`: todas as datas do certificado estão no horário de Brasília;
- `SHA-256 do original: <64 letras e números>`: a "impressão digital" do PDF **como foi enviado**, antes de qualquer assinatura. Se alguém tiver uma cópia do original, dá para conferir que é o mesmo arquivo.

No rodapé: o **ID do Envelope** (identificador único do documento), um **QR code** que leva à página pública do documento (ver seção 3) e, quando o documento tem prova congelada, a atribuição "IP Geolocation by DB-IP".

Cada pessoa ocupa um bloco com três colunas. Em ordem, para cada uma:

### Coluna "Eventos do Signatário"

| O que aparece | O que significa |
|---|---|
| Nome | Nome cadastrado pelo remetente no documento |
| E-mail | E-mail para onde foi o link de assinatura |
| Papel | `Signatário`, `Aprovador`, `Visualizador` etc. |
| Nível de Autenticação | Como o acesso foi protegido (ex.: autenticação de dois fatores, que é o código por e-mail) |

### Coluna "Assinatura"

| O que aparece | O que significa |
|---|---|
| Caixa verde | O desenho ou o nome digitado, se houver. Se a pessoa assinou só com o botão, a caixa diz `Assinado eletronicamente (carimbo)` |
| ID da Assinatura | Identificador interno do campo assinado |
| Endereço IP | Endereço de internet de onde a pessoa concluiu |
| Dispositivo | Sistema e navegador usados, ex.: `Android 14 · Chrome 130` |

### Coluna "Detalhes"

| Linha | O que significa | De onde vem |
|---|---|---|
| Enviado | Quando o documento foi enviado para a pessoa | Log do documento |
| Visualizado | Quando ela abriu o documento pela primeira vez (`Desconhecido` se ela nunca abriu a tela, por exemplo quando assina por integração) | Log do documento |
| Assinou em (ou Aprovou em, Visualizou em, Preencheu em) | Quando concluiu, conforme o papel | Prova congelada |
| Motivo | `Eu sou um signatário deste documento`; para o próprio remetente, `Eu sou o proprietário deste documento` | Papel |
| CPF | CPF mascarado (`***.456.789-**`), ou `não verificado` | Portão de identidade |
| Matrícula, Cargo, Setor, Unidade, Situação | Dados do RH **no momento da assinatura**. Se o RH mudar depois, o certificado não muda. `—` quando a base não tinha o dado | Base de colaboradores, congelada |
| Verificação | Cada forma de confirmação usada, com data e hora (ver abaixo) | Portão e código por e-mail |
| Termo aceito | Versão do termo de assinatura eletrônica e quando foi aceito, ex.: `Versão 1 em 29/10/2026 14:30` | Portão |
| Ordem de assinatura | Só em documento com ordem definida: a posição da pessoa, ex.: `2º de 3`. Pessoas de um mesmo grupo (podem assinar em qualquer ordem entre si) têm a mesma posição | Ordem do documento |
| Localização aproximada (IP) | Cidade/UF e país estimados pelo endereço IP, ex.: `Juazeiro/BA, Brasil`. A consulta é feita numa base dentro do próprio servidor; o IP não é enviado a ninguém. `não identificada` quando não dá para saber (rede interna, IP de teste) | Base DB-IP offline |
| Localização do aparelho | Latitude, longitude e precisão, ex.: `-9,4167, -40,5033 (±25 m)`, **se a pessoa autorizou** no navegador. Senão: `não autorizada` (recusou), `indisponível` (o aparelho não respondeu a tempo, ou a assinatura foi feita dentro de outro site, onde o navegador não deixa perguntar) ou `não solicitada` (nada foi pedido: quem só visualiza ou recebe cópia não passa pelo termo, então a localização do aparelho nunca é pedida a essas pessoas) | Navegador, opcional |
| Assinatura visual | `imagem (desenho/arquivo)`, `texto digitado` ou `somente carimbo`. Só para quem assina | Prova congelada |
| Código de verificação | O mesmo código do carimbo | Prova congelada |

As formas de **Verificação**:

| Texto | O que significa |
|---|---|
| Link por e-mail | Abriu o link pessoal que chegou no e-mail dele |
| Código por e-mail | Digitou o código de 6 dígitos enviado ao e-mail dele para concluir |
| Confirmação de colaborador | Primeira assinatura desse e-mail: digitou CPF e data de nascimento, que conferiram com a base, e confirmou "Sim, sou eu" |
| Vínculo de colaborador já confirmado | O e-mail já tinha sido ligado ao CPF numa assinatura anterior (ou pela base de RH), então não precisou digitar de novo |

Destinatário de documento assinado antes da Fase 4 não tem prova congelada: o bloco dele fica igual ao do Documenso original, sem as linhas acima.

## 3. Como conferir um documento no `/verificar`

1. Abra `https://assinatura.revalle.com.br/verificar` (em homologação, o endereço de homologação).
2. Digite o **código de verificação** de qualquer carimbo do documento. Maiúsculas, minúsculas e o hífen tanto faz.
3. A página mostra:
   - o título do documento;
   - a situação: `Concluído em <data>`, `Recusado em <data>` ou `Em andamento`;
   - **Participantes**: nome (o da base de RH; sem ele, por exemplo para quem só visualiza, o nome cadastrado no documento), CPF mascarado e a data em que cada um assinou (ou aprovou, visualizou…);
   - **SHA-256 do documento final** (só quando concluído). Se o documento foi **reselado** (ex.: troca do certificado da empresa), aparecem também as **versões seladas anteriores**, cada uma com a data da selagem.
4. Para saber se o PDF que você tem nas mãos é o mesmo que foi assinado, vá em **"Conferir um arquivo"** (aparece quando o documento já foi concluído) e escolha o PDF. A conta é feita no seu próprio navegador: o arquivo **não é enviado** para lugar nenhum. Resultado:
   - `Este arquivo confere com a versão selada em <data> (horário de Brasília).`: é um PDF final selado deste documento, sem nenhuma alteração;
   - se, além disso, aparecer `Existe uma versão selada mais recente deste documento, de <data>`: a cópia é legítima, mas o documento foi reselado depois (o selo digital foi refeito, por exemplo na troca do certificado da empresa). As assinaturas são as mesmas; quem precisar da versão atual pode baixá-la de novo;
   - `Este arquivo é diferente do documento assinado.`: o arquivo não confere com nenhuma versão selada: foi alterado, é uma versão de antes da conclusão ou é outro documento.

O que **não** aparece no `/verificar`, de propósito: e-mail, IP, aparelho, localização, CPF completo e o conteúdo do documento.

- Código errado ou de documento excluído/cancelado: `Código não encontrado.` (sem dizer mais nada).
- São no máximo 30 consultas a cada 15 minutos por endereço de internet (no IPv6, por rede `/64`, que costuma ser a de uma mesma casa ou empresa).

Outras formas de conferir:

- O selo digital pode ser conferido em qualquer leitor de PDF (painel de assinaturas do Adobe Reader) e, com o e-CNPJ de produção, no verificador do ITI (`certificado.md`).
- O QR code do certificado abre a página pública do documento no RevSign: título, quantidade de participantes, data de conclusão e o botão para baixar o PDF final.

## 4. Aceite da Fase 4 (para TI)

O aceite automatizado é o teste `scripts/revalle/tests/acceptance-f4.test.mjs`. Ele faz o que a spec pede (§7.3, "Aceite"): um documento com **três signatários em ordem**, incluindo o próprio remetente, e confere no PDF final cada linha do certificado e o carimbo de cada um.

### O que o teste faz

1. O remetente (conta com e-mail `@revalle.com.br`) cria um documento com ordem de assinatura e três signatários:
   1. ele mesmo, já com e-mail vinculado ao CPF: passa pelo vínculo;
   2. um colaborador com e-mail já vinculado (o vínculo é feito antes, no próprio teste, com um documento descartável);
   3. um colaborador assinando pela primeira vez: CPF + data de nascimento e "Sim, sou eu".
2. Antes da vez dele, o 3º tenta assinar: a página manda esperar e a conclusão é recusada.
3. Cada um passa pelo portão, abre o documento e conclui com o código do e-mail (lido no Mailpit). Só o 2º desenha. Localização do aparelho: o 1º autoriza, o 2º recusa, o 3º não envia.
4. No PDF final:
   - o carimbo de cada um, na área do próprio campo, com as 5 linhas e o CPF mascarado;
   - no certificado, cada linha da tabela acima com o valor esperado (dados do RH da base, fatores e horários, termo, ordem `1º de 3`/`2º de 3`/`3º de 3`, local por IP, `não autorizada`, `não solicitada`, `imagem (desenho/arquivo)`, `somente carimbo`, IP e aparelho);
   - `SHA-256 do original` igual ao do banco e ao do arquivo original;
   - nenhum CPF completo, nem no PDF nem no `/verificar`.
5. No `/verificar`, com cada um dos três códigos: `Concluído em`, os três participantes e o SHA-256 final, igual ao do PDF baixado.
6. Selagem: `verify-signed-pdf.sh` (assinatura íntegra e cobrindo o documento todo) e `inspect-pdf-signature.sh` (`DocMDP: P=2` e a política PAdES AD-RB v1.3).

### Como rodar

Pré-requisitos e variáveis: `testes.md`, seção "Aceite da Fase 4". Em resumo:

1. Stack local no ar com a imagem atual e os colaboradores fictícios do aceite carregados.
2. Token de API do remetente, criado na tela **Configurações → API** entrando com a conta do remetente.
3. Rodar a suíte inteira (o aceite faz parte dela), o smoke e o `verify-signed-pdf.sh`.

Resultado esperado: `fail 0`. Confira também que o aceite não aparece como `skipped`; sem o token do remetente ele é pulado.
