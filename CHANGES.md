# RevSign — alterações sobre o Documenso

Base: Documenso `v2.21.1` (`8707e33c`). Repositório: https://github.com/enzononato/RevSign

Este arquivo é o guia para trazer novas versões do upstream (`git fetch upstream --tags && git merge vX.Y.Z`).
Toda edição em arquivo do upstream é marcada com `REVALLE:` no código e listada abaixo.

## Arquivos do upstream alterados

| Arquivo | Mudança | Motivo | Fase |
|---|---|---|---|
| `.github/workflows/*.yml` (todos do upstream) e `.github/dependabot.yml` | Removidos | O RevSign não é fork, então o GitHub ativaria os workflows do upstream (`deploy.yml` roda em qualquer tag, `stale`/`translations-pull` são agendados, `publish.yml` publica em `documenso/*`). No merge de uma nova versão, conflito do tipo *modify/delete* nesses arquivos se resolve com `git rm` | 1 |
| `.gitignore` | Bloco `REVALLE:` no final | Impedir commit de `.env*`, certificados e chaves | 1 |
| `.husky/pre-commit` | Uma linha chamando `scripts/revalle/check-secrets.sh` | Bloqueio local de commit de segredos | 1 |
| `apps/remix/app/root.tsx` | Import + renderização de `<SourceCodeLink />` | AGPL §13: link "Código-fonte" em todas as telas | 1 |

## Arquivos novos (não conflitam com o upstream)

| Caminho | Conteúdo | Fase |
|---|---|---|
| `CHANGES.md` | Este arquivo | 1 |
| `.gitleaks.toml` | Configuração do gitleaks | 1 |
| `scripts/revalle/check-secrets.sh` | Checagem de segredos (pre-commit e CI) | 1 |
| `.github/workflows/revalle-secrets.yml` | Checagem de segredos no CI | 1 |
| `.github/workflows/revalle-image.yml` | Build e publicação da imagem no GHCR | 1 |
| `apps/remix/app/components/revalle/` | Componentes próprios | 1 |
| `revalle/` | Deploy, backup e documentação de operação | 1 |

## Checklist de atualização do upstream

1. `git fetch upstream --tags` e ler o changelog da nova versão.
2. `git merge vX.Y.Z` na branch `revalle` (merge, nunca rebase).
3. Resolver conflitos; conferir cada linha desta tabela (`git grep -n "REVALLE:"`).
4. Revisar migrações novas em `packages/prisma/migrations/` (rodam sozinhas no start).
5. Rodar os testes e o ensaio local (`revalle/deploy/compose.hml.yml`).
6. Tag `vX.Y.Z-revalle.1`, validar em homologação e só depois em produção.
