---
name: RevSign
description: Assinatura eletrônica interna da Revalle, em azul royal sobre papel quente, onde cada documento é um engradado cujos encaixes se enchem conforme as pessoas assinam.
colors:
  brand-royal: "#1D3F94"
  brand-deep: "#152F6F"
  brand-text-dark: "#80A8FF"
  brand-fill-dark: "#2A56C6"
  shell: "#1D3F94"
  shell-dark: "#172F6E"
  shell-muted: "#CBD8F6"
  wordmark-sign-on-brand: "#9EC0FF"
  ground: "#F5F4F0"
  card: "#FFFFFF"
  ink: "#141B2E"
  muted-surface: "#EDECE8"
  muted-ink: "#555C6D"
  hairline: "#E6E2DB"
  accent-wash: "#EBF0FA"
  counter-amber: "#F0B505"
  counter-ink: "#291D00"
  success: "#1E8052"
  success-wash: "#E7F4EC"
  warning-ink: "#8F6200"
  warning-wash: "#FFF5DB"
  danger: "#B42318"
  danger-wash: "#FDEAE8"
  ground-dark: "#0E1425"
  card-dark: "#151E32"
  ink-dark: "#E9EDF6"
  muted-surface-dark: "#1D273E"
  muted-ink-dark: "#A3ACC2"
  hairline-dark: "#26304A"
  accent-wash-dark: "#1B2850"
  danger-dark: "#F44034"
  danger-wash-dark: "#3B1C1C"
  success-dark: "#5DD096"
  success-wash-dark: "#123125"
  warning-ink-dark: "#F5C451"
  warning-wash-dark: "#32270B"
typography:
  display:
    fontFamily: "Nunito Sans, Figtree, sans-serif"
    fontSize: "2.25rem"
    fontWeight: 900
    lineHeight: 1.1
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "Nunito Sans, Figtree, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Figtree, sans-serif"
    fontSize: "1rem"
    fontWeight: 700
    lineHeight: 1.375
    letterSpacing: "0em"
  body:
    fontFamily: "Figtree, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0em"
  label:
    fontFamily: "Figtree, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0em"
rounded:
  slot: "10px"
  field: "13px"
  card: "20px"
  pill: "999px"
spacing:
  xs: "5px"
  sm: "10px"
  md: "18px"
  lg: "24px"
  sidebar: "244px"
components:
  button-primary:
    backgroundColor: "{colors.brand-royal}"
    textColor: "{colors.card}"
    rounded: "{rounded.pill}"
    height: "44px"
    padding: "8px 20px"
  button-outline:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    height: "44px"
    padding: "8px 20px"
  input:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    height: "44px"
    padding: "8px 14px"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "24px"
  badge-success:
    backgroundColor: "{colors.success-wash}"
    textColor: "{colors.success}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
  slot-signed:
    backgroundColor: "{colors.brand-royal}"
    textColor: "{colors.card}"
    rounded: "{rounded.slot}"
    height: "30px"
  slot-pending:
    backgroundColor: "{colors.card}"
    textColor: "{colors.muted-ink}"
    rounded: "{rounded.slot}"
    height: "30px"
  slot-rejected:
    backgroundColor: "{colors.danger-wash}"
    textColor: "{colors.danger}"
    rounded: "{rounded.slot}"
    height: "30px"
  filter-box:
    backgroundColor: "{colors.card}"
    textColor: "{colors.muted-ink}"
    rounded: "{rounded.field}"
    height: "44px"
  filter-box-active:
    backgroundColor: "{colors.accent-wash}"
    textColor: "{colors.brand-royal}"
    rounded: "{rounded.field}"
    height: "44px"
  nav-item-active:
    backgroundColor: "{colors.card}"
    textColor: "{colors.shell}"
    rounded: "14px"
    height: "44px"
  counter-chip:
    backgroundColor: "{colors.counter-amber}"
    textColor: "{colors.counter-ink}"
    rounded: "{rounded.pill}"
    height: "24px"
---

# Design System: RevSign

## Overview

**Creative North Star: "O Engradado"**

Cada documento é um engradado retornável: tem encaixes, e cada encaixe se enche quando alguém assina. O sistema recusa a tabela cinza com selos de status e mostra o andamento como encaixes cheios e vazios. A casca é azul royal da Revalle, moldada como plástico (régua escura por baixo dos itens cheios); o conteúdo é papel quente e cartões brancos macios. O azul só aparece onde existe algo a fazer, e a ação é sempre uma única pílula.

A voz é calma, firme e doméstica, de app de consumo, não de ERP: raios generosos, rótulos em português simples, números tabulares. Serve dois públicos com o mesmo peso: quem assina (celular, visita rara) e Financeiro/Contabilidade (desktop, o dia todo). Tema claro e escuro; no escuro o chão vira azul-marinho profundo e a casca continua azul moldado. O nome herói é **RevSign**; "revalle" aparece só como assinatura pequena.

**Key Characteristics:**
- Casca azul royal com grade de linhas finas de 24px, só na barra lateral e nas faixas de marca.
- Chão off-white quente (`#F5F4F0`), cartões brancos de raio 20, pílulas de raio 999.
- Títulos Nunito Sans 900 com aperto de -0.03em; interface em Figtree; algarismos tabulares.
- Estado lido pela forma (cheio, vazado, riscado), nunca só pela cor.
- Profundidade por contorno e régua inferior, não por sombra difusa.

## Colors

Paleta de uma voz só: azul de marca, papel quente, tinta azul-marinho, e um âmbar reservado ao contador. Os valores normativos estão no frontmatter; as variáveis HSL vivem em `packages/ui/styles/theme.css`.

### Primary
- **Azul Royal Revalle** (`#1D3F94`, `--primary` 223 67% 35%): preenchimento de botão primário, encaixe cheio, anel de foco, filtro ativo, casca (`--shell`). Branco sobre ele: 10,6:1.
- **Azul Régua** (`#152F6F`, `--brand-deep` 223 68% 26%): a régua de 2px/3px sob o botão primário e dentro do encaixe cheio. Nunca é fundo de área.
- **Azul de Texto** (claro `#1D3F94`; escuro `#80A8FF`, `--brand-text`): links, valores de filtro ativo, códigos. No escuro `--primary` (`#2A56C6`, branco 6,6:1) serve só para preenchimento; texto e links usam `--brand-text` (7,6:1).
- **Azul Claro da Marca** (`#9EC0FF`): somente o "Sign" do wordmark sobre a casca azul.

### Secondary
- **Âmbar do Contador** (`#F0B505` fundo, `#291D00` texto, `--counter`): o número de pendências no menu "Notas fiscais". É o único uso; igual nos dois temas.

### Neutral
- **Papel Quente** (`#F5F4F0`, `--background`): chão do app. Escuro: **Marinho Fundo** `#0E1425`.
- **Cartão** (`#FFFFFF`, `--card`): linhas, painéis, campos. Escuro `#151E32`.
- **Tinta Marinho** (`#141B2E`, `--foreground`): texto, 15,5:1 sobre o chão. Escuro `#E9EDF6` (15:1).
- **Tinta Apagada** (`#555C6D`, `--muted-foreground`): metadados, rótulos de filtro. Escuro `#A3ACC2` (7,9:1 no cartão).
- **Superfície Apagada** (`#EDECE8`, `--muted`): pílula de situação neutra, etiquetas de conta e centro. Escuro `#1D273E`.
- **Fio** (`#E6E2DB`, `--border`/`--input`): contorno de campos, divisores. Escuro `#26304A`; borda de campo escuro `#455887`.
- **Lavado Azul** (`#EBF0FA`, `--accent`/`--secondary`): hover, filtro ativo, encaixe "você". Escuro `#1B2850`.
- **Casca** (`#1D3F94`; escuro `#172F6E`, `--shell`), texto `#FFFFFF`, texto apagado `#CBD8F6` (`--shell-muted`); item inativo `#D4DEF5`.

### Status (sempre par fundo + texto, ≥ 4,5:1)
- **Sucesso** `#1E8052` sobre `#E7F4EC`; escuro `#5DD096` sobre `#123125`.
- **Atenção** `#8F6200` sobre `#FFF5DB`; escuro `#F5C451` sobre `#32270B`. O amarelo de preenchimento `--warning` (45 96% 48%) não é texto.
- **Perigo** `#B42318` sobre `#FDEAE8`; escuro `#F44034` sobre `#3B1C1C`.

### Named Rules
**The Action-Only Blue Rule.** Azul sólido significa "há algo que você pode fazer agora". Botão de ação, filtro que restringe a lista, encaixe cheio e item ativo. Texto corrido, ícones decorativos e situações passivas não são azuis; situação sem ação usa a pílula cinza (verde ao concluir, vermelha ao recusar).

**The One Amber Rule.** O âmbar existe só para o contador de pendências. Não vira destaque, aviso nem decoração.

**The Pair Rule.** Todo status é fundo lavado + texto escuro da mesma família. Nunca texto de status sobre o chão branco sem o fundo.

## Typography

**Display Font:** Nunito Sans 800/900 (fallback Figtree, sans-serif), autohospedada em `/fonts`
**Body Font:** Figtree 400–800 (fallback sans-serif), autohospedada
**Label/Mono Font:** não há mono. Algarismos tabulares no `body` (`font-variant-numeric: tabular-nums`).

**Character:** Nunito Sans pesada e arredondada dá cara de logotipo aos títulos e aos números de destaque; Figtree mantém a leitura de lista limpa e amigável.

### Hierarchy
- **Display** (900, ~36px, 1.1, -0.03em): `h1`/`h2` de página (regra global em `theme.css`), wordmark.
- **Headline** (800, 18px, 1, -0.02em): `CardTitle`, `DialogTitle` (20px), contador do menu.
- **Title** (700, 16px, 1.375): título da linha de documento/NF (Figtree, não Nunito).
- **Body** (400, 15px, 1.5): texto corrido; campos usam 14px no desktop e 16px no celular.
- **Label** (600, 13px): metadados, rótulos de filtro, etiquetas; botões 14.5px/700; pílula de ação 13.5px/700.

### Named Rules
**The Heavy Headline Rule.** Só `h1`, `h2`, números de destaque e iniciais de encaixe usam Nunito Sans pesada. Linhas de lista e texto de interface são Figtree.

**The Tabular Rule.** Valores, contadores e datas usam algarismos tabulares para alinhar colunas.

## Layout

Casca de duas colunas no desktop: barra lateral fixa de 244px (`sticky`, `h-dvh`) e coluna principal de até 1260px centralizada, com respiro de 34px no topo. No celular a barra vira faixa de 60px com folha azul. Na lista de NF, o conteúdo tem a coluna de filas à direita com 316px ("Suas filas", botão primário "Enviar nota fiscal", ghost "Exportar planilha"); no celular as filas viram uma faixa acima da lista.

A linha de documento é um cartão que reage à largura do próprio contêiner (container queries): estreito (< 576px) empilha e a ação ocupa a largura; médio (576–896px) título numa linha e encaixes | ação | menu na de baixo; largo (>= 896px) uma linha só com colunas `título | 150px encaixes | 168px ação | 44px menu`. Ritmo: lacuna de 10px entre cartões, 18px entre colunas, 5px entre encaixes. Alvos de toque de 44px sempre (o encaixe tem 26–30px de desenho e 44px de área).

## Elevation & Depth

Híbrido plano: cartões têm contorno de sombra de 1px mais uma sombra de 1px quase invisível (`shadow-card`: `0 1px 2px rgba(20,27,46,.05), 0 0 0 1px rgba(20,27,46,.04)`); no escuro o contorno é `0 0 0 1px hsl(var(--border))`. A profundidade "moldada" vem da régua inferior, não de névoa: botão primário `shadow-ridge` (`0 2px 0 hsl(var(--brand-deep))`, some ao pressionar com `translate-y-px`) e encaixe cheio (`inset 0 -3px 0 brand-deep`). Diálogos usam `shadow-xl` e overlay `bg-background/80` com `backdrop-blur-sm`; é o único desfoque do sistema.

### Named Rules
**The Ridge Rule.** O que é clicável e cheio tem régua escura por baixo; o que é vazado tem contorno interno (`inset 0 0 0 2px`). Nenhuma sombra difusa colorida.

## Shapes

Linguagem de peças encaixáveis: cartões de raio 20px (`rounded-card`), campos e caixas de filtro 13px (`--radius`, `rounded-lg`), encaixes 10px (12px no tamanho grande), item ativo de menu 14px, botões, chips, etiquetas e contadores totalmente redondos (999px). Campos têm contorno de 1.5px; filtro ativo, 2px azul. Sem cantos vivos e sem sombras duras deslocadas.

## Components

### Buttons
- **Forma:** pílula (`rounded-full`), altura 44px (sm 36px, lg 54px), texto 14.5px/700.
- **Primário:** fundo `#1D3F94`, texto branco, régua `#152F6F` de 2px; hover a 90%; ativo desce 1px e perde a régua. Uma por visão.
- **Outline:** fundo cartão, contorno 1.5px `#E6E2DB`, hover lavado azul. É o "ghost" de Exportar planilha.
- **Destrutivo:** vermelho `#B42318` com régua preta a 25%. **Secundário/ghost/link** seguem os lavados; link usa `--brand-text`.
- **Foco:** anel de 2px `--ring` com offset de 2px, em todos os controles.

### Chips (etiquetas e selos)
- **Estilo:** pílula, 26px de altura nas linhas de NF, 13px/600. Conta e centro de custo: fundo `--muted` com código em Nunito 800 azul. Concluído: verde lavado com check. Pendência de leitura da IA: âmbar lavado. Divergência: vermelho lavado.
- **Badge** (`badge.tsx`): variantes neutral, destructive, warning, default (verde), secondary, orange; tamanhos small, default, large.

### Cards / Containers
- **Raio:** 20px. **Fundo:** `--card`. **Sombra:** ver Elevation. **Borda:** só o contorno de sombra. **Padding:** 24px (`CardHeader`/`CardContent`); linhas de lista 16px, com 22px à esquerda.
- Títulos de cartão em Nunito 800 18px.

### Inputs / Fields
- **Estilo:** altura 44px, raio 13px, contorno 1.5px `--input`, fundo cartão, placeholder a 60%.
- **Foco:** borda `--primary`, anel de 2px. **Erro:** anel `--destructive`. **Desabilitado:** 50% de opacidade.

### Navigation
- Barra lateral azul (`--shell`), item de 44px mínimo, raio 14px, 15px/600. **Ativo:** fundo branco com texto azul da casca. **Inativo:** `#D4DEF5`; hover `bg-white/10`. Foco anel branco com offset na cor da casca. Contador de Notas fiscais em âmbar; o da Caixa de entrada é discreto (`bg-white/15`), de Nunito 800 12.5px.
- Busca em pílula `bg-white/10` com atalho de teclado. Rodapé: cartão do usuário e link "Código-fonte (AGPL-3.0)", sempre visível.
- Abas (`tabs.tsx`): 44px, sublinhado de 3px no ativo, texto 14px/600.

### Barra lateral com grade (assinatura)
Fundo `--shell` com duas camadas `repeating-linear-gradient` brancas a 4,5% de opacidade, linhas de 1px a cada 24px na horizontal e na vertical (`SHELL_GRID_STYLE`). É o único lugar com textura; vale também para faixas de marca e telas de entrada.

### Wordmark RevSign (assinatura)
"Rev" em branco e "Sign" em `#9EC0FF` sobre a casca; sobre fundo claro, "Rev" em `--foreground` e "Sign" em `--brand-text`. Nunito 900, aperto -0.035em, entrelinha 1. Tamanhos 22/28/34/56px. Legenda opcional "assinaturas da **revalle**" (12px, "revalle" em Nunito 900 14px). O wordmark é `role="img"` com rótulo "RevSign".

### Encaixes de assinatura (assinatura)
Um por destinatário que assina: bloco de 30px (26 pequeno, 40 grande), raio 10px, iniciais em Nunito 900 11px (ou "Você"). Estado pela forma:
- **Assinou:** cheio `#1D3F94`, texto branco, régua interna inferior de 3px `#152F6F`.
- **Falta:** vazado, fundo cartão, contorno interno de 2px `--input`.
- **Você (falta):** lavado azul com contorno de 2px azul e texto de marca.
- **Recusou:** lavado vermelho, contorno vermelho e risco diagonal de 2px a -45°.
- Mais de `max` (3 em linha, 6 por padrão) vira "+N" em 12px/700 cinza. Tooltip com nome e estado.
- **Movimento de preenchimento:** só quando o encaixe chega cheio depois de ter estado vazio (a lista recarregou e alguém assinou) ou com `justFilled` (tela de concluído). Entra de escala 0,8 e a tinta sobe de baixo, uma vez, 420ms, `cubic-bezier(0.16, 1, 0.3, 1)`. Sem animação com `prefers-reduced-motion`. Abrir a página não anima nada.

### Cartão de linha (assinatura)
`<tr>` do DataTable vira cartão (`document-row-card`, `invoice-row-card`): título 16px/700 (até 2 linhas), meta em 13px cinza ("remetente · data"), etiquetas de conta e centro, valor à direita em 14px/800, encaixes, e **uma** pílula de ação azul ou a pílula cinza de situação, mais menu "…" de 44px. Selecionada: anel de 2px azul por dentro. Continua semanticamente uma tabela.

### Caixas de filtro rotuladas (assinatura)
Barra sempre visível: busca em linha inteira, depois caixas de 44px com rótulo + valor + chevron (`filterBoxClassName`). Repouso: fundo cartão, contorno de 1.5px, rótulo cinza e valor em tinta 700. **Restringindo a lista:** fundo lavado azul, contorno de 2px `--brand-text`, valor em azul. Por baixo há um `<select>` nativo invisível (no celular abre a roda do sistema); filtros maiores usam o mesmo desenho como botão de popover.

## Do's and Don'ts

### Do:
- **Do** usar azul `#1D3F94` só para ação, filtro restringente, encaixe cheio, item ativo e foco.
- **Do** mostrar andamento com encaixes (cheio, vazado, riscado) e manter o estado legível sem cor.
- **Do** usar pílula (999px) para ação, etiqueta e contador; 20px para cartão; 13px para campo.
- **Do** usar os tokens (`bg-card`, `text-muted-foreground`, `bg-success-bg`...) em vez de hex, e testar nos dois temas.
- **Do** manter uma única ação por linha e um único botão primário por visão.
- **Do** manter alvos de toque de 44px e anel de foco de 2px.
- **Do** respeitar `prefers-reduced-motion` em qualquer movimento novo.

### Don't:
- **Don't** usar azul para texto corrido, ícone decorativo ou situação passiva.
- **Don't** voltar ao padrão tabela cinza com selos de status coloridos.
- **Don't** usar o âmbar fora do contador de pendências.
- **Don't** usar `--primary` (`#2A56C6`) como cor de texto no escuro; use `--brand-text` (`#80A8FF`).
- **Don't** usar texto de status sem seu fundo lavado par.
- **Don't** usar sombra difusa, sombra dura deslocada ou brilho colorido; profundidade é régua e contorno.
- **Don't** aplicar a grade de 24px fora da casca azul e das faixas de marca.
- **Don't** usar Nunito pesada em texto de lista ou parágrafo.
- **Don't** esconder o link "Código-fonte (AGPL-3.0)" nem mudar fluxo, textos legais, prova ou permissões ao estilizar.

## Onde vive no código

- Tokens claro/escuro, regras de `h1`/`h2`, foco, seleção, rolagem: `packages/ui/styles/theme.css`.
- Mapeamento Tailwind (cores, `rounded-card`, `shadow-card`, `shadow-ridge`, fontes): `packages/tailwind-config/index.cjs`.
- Fontes autohospedadas (Figtree, Nunito Sans 800/900): `apps/remix/app/app.css`.
- Primitivos: `packages/ui/primitives/{button,input,card,badge,table,tabs,dialog}.tsx`.
- Casca e wordmark: `apps/remix/app/components/revalle/shell/{app-shell,shell-nav,revsign-wordmark,shell-routes}.tsx`, barra em `components/general/app-nav-desktop.tsx`; grade em `SHELL_GRID_STYLE`.
- Encaixes e movimento: `components/revalle/shell/signer-slots.tsx`, `components/tables/recipient-signer-slots`.
- Linhas: `components/revalle/invoice/list/invoice-row-card.tsx`, `components/tables/document-row-card.tsx`.
- Filtros e filas: `components/revalle/invoice/list/{invoice-filter-box,invoice-filter-bar,invoice-queues}.tsx`.
- Contrato de direção: `apps/remix/.impeccable/surfaces/app-root-tsx.md`.

*Não canonizado (defeitos que o build carrega, ver relatório):* `documenso` e `dawn`/`water` seguem no Tailwind por herança do upstream; `--warning` amarelo é só preenchimento.
