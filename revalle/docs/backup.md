# RevSign — backup e restauração

## O que é salvo e por quê

- O banco do RevSign inteiro. Ele guarda tudo: PDFs (original e final), assinaturas, logs de auditoria e contas.
- Todo dia às 02:00 (horário da Bahia) o serviço `revsign-backup` faz uma cópia, cifra com a chave pública `age` e grava na VPS (volume `/backups`).
- Em seguida copia para a hospedagem do cPanel, FORA da VPS. Por quê: se a VPS sumir, as cópias sobrevivem.
- O arquivo é cifrado antes de sair do banco: quem pegar o arquivo sem a chave privada não lê nada.
- Retenção: `BACKUP_RETENTION_DAYS=30` guarda um arquivo por dia dos últimos 30 dias; os mais antigos são apagados sozinhos, nos dois lados, e o arquivo mais novo nunca é apagado.
- O resultado da última execução fica em `/backups/last-run.json` (campos `status` = `ok` ou `error`, `finishedAt`, `file`, `message`).

## Onde guardar a chave privada

- O arquivo `backup-age-identity.txt` (gerado no passo 0 do `deploy.md`) é a chave PRIVADA. Sem ela, nenhum backup abre.
- Fica com o Enzo e no cofre de senhas. Nunca na VPS, nunca no EasyPanel, nunca no repositório.
- No EasyPanel entra só a chave pública (`BACKUP_AGE_RECIPIENT`, linha `age1...`).
- Guarde uma segunda cópia do cofre em outro lugar. Se perder a chave, perde os backups.

## Criar a conta FTP no cPanel (recomendado: FTPS)

1. No cPanel, abra **File Manager** e, na pasta pessoal (home), crie uma pasta `revsign-backups`.
2. Abra **FTP Accounts**.
3. Em **Log In**, escreva um nome, por exemplo `revsignbkp`.
4. Em **Directory**, escreva `revsign-backups`. Isso prende a conta a essa pasta.
5. Em **Password**, gere uma senha forte e guarde no cofre.
6. Em **Quota**, escolha um limite (por exemplo 5 GB) ou **Unlimited**.
7. Clique em **Create FTP Account**.
8. Na lista **FTP Accounts**, clique em **Configure FTP Client** na conta criada e anote o **FTP Server** (host).
9. No `backup.env` (ou direto no EasyPanel, serviço `revsign-backup`, aba **Environment**), tire o `#` destas linhas e preencha:
   - `BACKUP_REMOTE_TYPE=ftps`
   - `BACKUP_REMOTE_HOST=` o host anotado
   - `BACKUP_REMOTE_PORT=21`
   - `BACKUP_REMOTE_USER=` o login completo mostrado pelo cPanel (costuma ser `revsignbkp@revalle.com.br`)
   - `BACKUP_REMOTE_PASSWORD=` a senha
   - `BACKUP_REMOTE_PATH=revsign-backups` (se o cPanel já prende a conta na pasta, a pasta aparece como raiz; se o backup der erro de pasta, tente `BACKUP_REMOTE_PATH=/`)
10. Salve e reinicie. Se o log reclamar de certificado, use no `BACKUP_REMOTE_HOST` o nome que está no certificado do servidor (o cPanel mostra o nome do servidor em **Configure FTP Client**).

## Alternativa: SFTP (se a hospedagem liberar SSH)

1. No cPanel, procure **SSH Access**. Se não existir, a hospedagem não oferece: use FTPS.
2. Se existir, a página mostra a porta (geralmente 22, mas algumas hospedagens usam uma porta diferente). Use essa.
3. O login é o usuário do cPanel (ou outro que a hospedagem permita) e a senha dele. Pergunte à hospedagem se o SFTP está liberado para a conta.
4. No `backup.env`, use as linhas de exemplo, mas com `BACKUP_REMOTE_TYPE=sftp`, `BACKUP_REMOTE_PORT=` a porta, host, usuário e senha, e `BACKUP_REMOTE_PATH=revsign-backups`.
5. Opcional, mais seguro (verifica se o servidor é mesmo o da hospedagem; sem isto, a chave do servidor NÃO é conferida):
   1. No WSL, rode `ssh-keyscan -p PORTA HOST` e copie as linhas que aparecem.
   2. No EasyPanel, serviço `revsign-backup` → aba **Mounts** → **Add Mount** → tipo **File**.
   3. **Mount Path**: `/known_hosts`. **Content**: cole as linhas. **Save**.
   4. Tire o `#` da linha `BACKUP_REMOTE_KNOWN_HOSTS_FILE=/known_hosts` e reinicie.

## Variáveis BACKUP_*

| Variável | Padrão | O que faz |
|---|---|---|
| `BACKUP_DATABASE_URL` | obrigatória | Banco copiado (Internal Connection URL) |
| `BACKUP_AGE_RECIPIENT` | obrigatória | Chave pública `age1...` que cifra os arquivos |
| `BACKUP_CRON` | `0 2 * * *` | Horário (cron). Padrão: todo dia às 02:00 |
| `BACKUP_RETENTION_DAYS` | `30` | Dias de cópias guardadas |
| `BACKUP_RUN_ON_START` | `false` | `true` faz um backup ao subir o serviço |
| `BACKUP_REMOTE_TYPE` | `none` | `none`, `ftps` ou `sftp` |
| `BACKUP_REMOTE_HOST` | vazio | Servidor da hospedagem |
| `BACKUP_REMOTE_PORT` | 21 (ftps) / 22 (sftp) | Porta |
| `BACKUP_REMOTE_USER` | vazio | Usuário |
| `BACKUP_REMOTE_PASSWORD` | vazio | Senha (segredo) |
| `BACKUP_REMOTE_PATH` | `revsign-backups` | Pasta de destino |
| `BACKUP_REMOTE_KNOWN_HOSTS_FILE` | comentada | Só SFTP com arquivo montado: caminho do `known_hosts`. No FTPS, deixe comentada |
| `BACKUP_REMOTE_INSECURE_TLS` | `false` | Só testes: aceita certificado FTPS inválido |

## Conferir que o backup está rodando

1. No EasyPanel, serviço `revsign-backup` → aba **Logs**: deve aparecer `backup concluido` depois das 02:00.
2. No cPanel → **File Manager** → pasta `revsign-backups`: deve haver um arquivo `revsign-AAAAMMDD-HHMMSS.dump.age` por dia.

## Testar a restauração (no WSL)

Por quê: backup que nunca foi restaurado não é backup. O teste baixa o arquivo mais novo, abre com a chave privada num Postgres descartável e confere que um PDF selado volta íntegro. Nada é feito no banco de verdade.

Pré-requisitos:

- WSL com Docker funcionando (`docker ps` sem erro).
- O arquivo `backup-age-identity.txt` (chave privada) no WSL.
- O repositório clonado (o script usa `scripts/revalle/verify-signed-pdf.sh`).
- Para usar `latest`, as variáveis do backup remoto no terminal.

Comando para o arquivo mais novo da hospedagem:

```bash
cd ~/projetos/assinaturas-revalle/documenso
export BACKUP_REMOTE_TYPE=ftps BACKUP_REMOTE_HOST=<host> BACKUP_REMOTE_PORT=21 \
  BACKUP_REMOTE_USER=<usuario> BACKUP_REMOTE_PATH=revsign-backups
read -rs -p "Senha FTP: " BACKUP_REMOTE_PASSWORD; export BACKUP_REMOTE_PASSWORD; echo
sh revalle/backup/restore-test.sh latest /caminho/para/backup-age-identity.txt
```

Para um arquivo já baixado: `sh revalle/backup/restore-test.sh /caminho/revsign-AAAAMMDD-HHMMSS.dump.age /caminho/para/backup-age-identity.txt`

Resultado esperado: a última linha é `RESUMO: restauração OK, N envelope(s) concluído(s), PDF selado íntegro`. Qualquer linha começando com `FALHA` significa que o teste não passou. O teste exige pelo menos um documento concluído no banco; antes de ter um, ele falha com `FALHA nenhum envelope COMPLETED no backup`.

Faça o teste ao final da homologação, a cada mudança de versão e uma vez por trimestre. Anote cada teste na tabela abaixo.

## Registro de testes de restauração

| Data | Origem do backup | Resultado | Observações |
|---|---|---|---|
| 29/10/2026 | ensaio local | OK | PDF selado íntegro |
