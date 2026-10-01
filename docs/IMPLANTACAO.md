# Como colocar o sistema no ar

Roteiro para publicar o sistema na internet, com endereço próprio e HTTPS (cadeado), para
a equipe acessar de qualquer lugar. Leva cerca de 30 minutos.

## 1. O que você precisa

| Item | Detalhes |
|------|----------|
| **Servidor (VPS)** | Ubuntu 24.04, 1 vCPU, 1 a 2 GB de memória, 25 GB de disco. Qualquer provedor serve (Hostinger, DigitalOcean, AWS Lightsail, Contabo, Magalu Cloud, etc.). Prefira a região **São Paulo**. Os planos de entrada bastam. |
| **Domínio** | Um subdomínio do site do escritório, por exemplo `notas.seuescritorio.com.br`. Sem domínio, dá para usar um endereço gratuito do tipo `203-0-113-10.sslip.io` (o instalador sugere o seu). |
| **Acesso ao GitHub** | Para o servidor baixar o código, que está no repositório privado `guilhermecontabilizatech-source/testes`. |

## 2. Apontar o domínio para o servidor

No painel onde o domínio do escritório é administrado (Registro.br, Hostinger, Cloudflare…),
crie um registro DNS:

| Tipo | Nome | Valor |
|------|------|-------|
| A | `notas` | IP do servidor |

A propagação costuma levar de alguns minutos a algumas horas. Para conferir, acesse
<https://dnschecker.org> e pesquise o domínio.

## 3. Criar um token de leitura no GitHub

Como o repositório é privado, o servidor precisa de uma "senha" só de leitura:

1. GitHub → foto do perfil → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. Em *Repository access*, escolha **Only select repositories** → `testes`.
3. Em *Permissions* → *Repository permissions* → **Contents: Read-only**.
4. Gere e copie o token. Ele será usado no próximo passo, no lugar da senha.

## 4. Instalar no servidor

Entre no servidor pelo terminal. No Windows, abra o PowerShell; no Mac, o Terminal:

```bash
ssh root@IP_DO_SERVIDOR
```

Depois, rode os comandos abaixo. No `git clone`, o usuário é o seu login do GitHub e a
senha é o **token** do passo 3.

```bash
apt update && apt install -y git
git clone https://github.com/guilhermecontabilizatech-source/testes.git /opt/notas
cd /opt/notas
sudo bash deploy/instalar.sh
```

O instalador pergunta o domínio, o e-mail e a senha do administrador. Em seguida, ele:

- instala o Docker;
- ativa o firewall, deixando abertas só as portas 22, 80 e 443;
- sobe o sistema com HTTPS automático.

No fim, ele mostra o endereço de acesso. Por segurança, a senha digitada não fica gravada
no servidor depois da instalação.

## 5. Primeiro acesso

1. Abra `https://notas.seuescritorio.com.br` e entre com o e-mail e a senha do administrador.
2. Em **Empresas**, cadastre os clientes com plano de notas e honorário.
3. Em **Usuários**, crie o acesso de cada pessoa da equipe com o perfil **Equipe do escritório**.
4. Se quiser, crie também o acesso dos clientes com o perfil **Cliente**, ligado à empresa de cada um.

## 6. Backups

- **Automático:** todo dia às 3h (horário de Brasília), o sistema copia o banco e os anexos
  novos para `/opt/notas/deploy/dados/backups`. As cópias do banco ficam guardadas por 30 dias.
- **Manual,** a qualquer momento:
  ```bash
  cd /opt/notas/deploy && docker compose exec app node scripts/backup.js
  ```
- **Fora do servidor (recomendado):** se o servidor for perdido, os backups vão junto. Faça
  as duas coisas abaixo:
  - ative os **snapshots automáticos** no painel do provedor;
  - copie a pasta de backups para o Google Drive do escritório com o
    [rclone](https://rclone.org/drive/):
    ```bash
    curl https://rclone.org/install.sh | sudo bash
    rclone config            # crie um "remote" chamado gdrive, do tipo Google Drive
    # copiar todo dia às 4h:
    (crontab -l 2>/dev/null; echo "0 7 * * * rclone copy /opt/notas/deploy/dados/backups gdrive:backup-notas") | crontab -
    ```
    O horário do cron está em UTC: 7h UTC equivalem a 4h em Brasília.

### Restaurar um backup

```bash
cd /opt/notas/deploy
docker compose stop app
ls dados/backups                                   # escolha a cópia
cp dados/backups/notas-AAAA-MM-DD-HH-MM.db dados/notas.db
rm -f dados/notas.db-wal dados/notas.db-shm
cp -n dados/backups/anexos/* dados/anexos/
docker compose start app
```

## 7. Atualizar para uma versão nova

Quando houver melhorias no código, rode:

```bash
cd /opt/notas && sudo bash deploy/atualizar.sh
```

O script faz um backup, baixa a versão nova e reinicia o sistema. Os dados são mantidos.

## 8. Comandos úteis

Todos os comandos abaixo devem ser rodados dentro de `/opt/notas/deploy`.

| Para… | Comando |
|-------|---------|
| Ver se está tudo rodando | `docker compose ps` |
| Ver os registros (erros, backups) | `docker compose logs --tail 100 app` |
| Reiniciar | `docker compose restart` |
| Redefinir a senha de alguém | `docker compose exec app node scripts/redefinir-senha.js email@escritorio.com.br 'nova-senha'` |

## 9. Problemas comuns

| Sintoma | O que fazer |
|---------|-------------|
| O navegador diz que o site não é seguro, ou não abre | Confira se o DNS já aponta para o servidor (dnschecker.org) e se as portas 80 e 443 estão liberadas também no painel do provedor. Depois rode `docker compose restart caddy`. |
| "Muitas tentativas de login" | Por segurança, o login fica bloqueado por 15 minutos após 5 senhas erradas. Espere, ou redefina a senha. |
| Esqueceu a senha do administrador | Use o comando de redefinir senha da seção 8. |
| O servidor ficou sem espaço | Veja o tamanho da pasta com `du -sh /opt/notas/deploy/dados/*`. Os anexos são o que mais cresce. Se precisar, aumente o disco no painel do provedor. |
