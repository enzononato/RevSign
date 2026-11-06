---
version: 1
slug: "app-root-tsx"
primary_target: "app/root.tsx"
related_targets: ["app/routes"]
---

# RevSign app (redesign v3)

Scope: the whole RevSign web app (apps/remix + packages/ui): shell, documents, notas fiscais, document/NF page, signing (public), verificar, auth, settings, admin. Mode: Operate.

Audience/task: signers (phone, rare visits) and Financeiro/Contabilidade (desktop, all day) equally. Constraints: no flow, legal text, proof or permission change; AGPL link visible; light and dark.

Approved preview: `.impeccable/mocks/fusao-desktop.html`, `.impeccable/mocks/fusao-celular.html`, filter bar `.impeccable/mocks/filtro-A.html` (chosen by Enzo 06/11/2026). User asks: RevSign is the hero name (not revalle); keep the Engradado sidebar details (grid hairlines, white active item, amber counter, user card).

## Direction contract

THESIS: Every document is a returnable crate whose slots fill as people sign; the app refuses the grey SaaS table-with-badges default and shows progress as filled vs empty slots, with blue only where something can be done.

OWN-WORLD: Royal Revalle blue #1D3F94 molded shell (sidebar with 24px hairline grid), warm off-white ground #F5F4F0, white soft cards radius 20, pills radius 999. Nunito Sans 900 display (logo-like heavy rounded), Figtree UI text, tabular figures. Signer slots: filled blue tile with inset bottom ridge, empty tile outlined. Amber count chip. Dark mode: deep navy ground, same molded blue shell.

STORY: The visitor sees at once what waits for them (queues, counter), what each NF is (supplier, account, cost center, value), who still has to sign (slots), and the one action available to them.

FIRST VIEWPORT: Left 244px blue sidebar: RevSign wordmark (Sign in light blue) with "assinaturas da revalle", nav with amber counter, user card, AGPL link. Main: heavy H1, one-line status, always-visible filter bar (search full row, then labeled pill-boxes; active filter blue), list of NF row-cards (title, account and center tags, value, sender; slots; action pill). Right 316px column: "Suas filas" card, primary "Enviar nota fiscal", ghost "Exportar planilha".

FORM: Engradado (returnable beverage crate), position 7 of my ordered list, fused with the competitive challenger "warm consumer app" (action-only blue, soft radii, plain labels). seed:1e827aaeaa821462

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
