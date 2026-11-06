# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Dois públicos, com o mesmo peso (confirmado pelo Enzo em 06/11/2026):

- **Quem assina:** colaboradores da Revalle que recebem um link por e-mail, conferem o documento (muitas vezes uma nota fiscal) e assinam, com frequência pelo celular. Abrem o sistema poucas vezes e precisam entender na hora o que estão assinando.
- **Financeiro e Contabilidade:** pessoas que passam o dia no sistema, no computador, conferindo listas de notas fiscais, aprovando a conta contábil (Financeiro) e validando ou corrigindo o centro de custo (Contabilidade).
- **Administrador (TI):** importa o plano de contas e o prompt da IA, marca os perfis, gerencia usuários.

## Product Purpose

RevSign é a assinatura eletrônica interna da Revalle (revenda e distribuição Ambev), um fork do Documenso v2.21.1 em pt-BR. Ele faz notas fiscais e documentos internos serem assinados por quem precisa, com prova forte de quem assinou, e passa cada nota pelo Financeiro e pela Contabilidade antes de concluir. Sucesso: nenhuma nota fica parada sem alguém saber, e qualquer assinatura pode ser verificada depois.

## Positioning

Não é um assinador genérico: cada assinatura é conferida contra a base de RH da Revalle (CPF e data de nascimento), a nota fiscal leva conta contábil e centro de custo como parte do que é assinado, e o PDF final traz a conta e o centro escritos e um código verificável em `/verificar`.

## Operating Context

- Notas fiscais (NF-e, NFS-e, CT-e) chegam em PDF; o remetente envia, a IA (Gemini) sugere a conta contábil e lê fornecedor, número e valor; os destinatários assinam pelo link.
- Financeiro aprova a conta (só então a NF conclui); Contabilidade valida o centro de custo ou corrige com motivo, o que cria uma nova versão para todos assinarem de novo.
- Sem e-mails de fluxo: o aviso é o contador no menu **Notas fiscais** e as filas por perfil.
- Certificado de assinatura e página pública `/verificar` com código, fatores de identificação e termo aceito.

## Capabilities and Constraints

- Stack existente: React Router (remix app), Tailwind, shadcn/ui, Radix, Lingui pt-BR, Konva no editor de campos. Tokens em `packages/ui/styles/theme.css`.
- Tema claro e escuro (o Enzo usa o escuro no dia a dia).
- Não alterar `packages/ee`. Não mudar fluxo, textos legais, regras de assinatura, prova ou permissões no redesign.
- Centros de custo fixos: 101 Puxada, 201 Armazém, 301 Administrativo, 401 Vendas, 501 Entrega.
- Link "Código-fonte (AGPL-3.0)" precisa continuar visível (licença).

## Brand Commitments

- Nome do produto: **RevSign**.
- Logo da Revalle: wordmark "revalle" em branco, minúsculas, traço grosso e arredondado, sobre azul royal, com "REVENDA E DISTRIBUIÇÃO AMBEV" embaixo. O arquivo original ainda não está no projeto (o Enzo vai salvar em `assinaturas-revalle/marca/`).
- Evitar (todos confirmados): pesado ou burocrático, informal ou colorido, genérico de SaaS, futurista ou escuro demais.

## Evidence on Hand

- Logo RevSign atual em texto: `revalle/brand/logo.svg`.
- Dados reais de produção: poucas NFs de teste. Prévias usam dados sintéticos rotulados como tal.
- Não existem depoimentos, números de uso ou clientes externos; nada disso deve ser inventado.

## Product Principles

1. O que vai ser assinado fica claro antes de tudo: documento, conta, centro de custo, valor.
2. Quem precisa agir sabe disso sem e-mail: filas e contadores visíveis.
3. Confiança se mostra com prova verificável, não com enfeite.
4. Uma pessoa que abre o sistema uma vez por mês e uma que passa o dia nele devem se sentir em casa.

## Accessibility & Inclusion

Uso em celular por colaboradores de operação (armazém, entrega): alvos de toque grandes, contraste alto, texto legível ao ar livre.
