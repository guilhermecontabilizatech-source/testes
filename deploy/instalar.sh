#!/usr/bin/env bash
# Instala o sistema num servidor Ubuntu/Debian novo. Uso (como root, dentro da pasta do projeto):
#   bash deploy/instalar.sh
set -euo pipefail

PASTA="$(cd "$(dirname "$0")" && pwd)"
cd "$PASTA"

if [[ $EUID -ne 0 ]]; then
  echo "Rode como root:  sudo bash deploy/instalar.sh" >&2
  exit 1
fi

echo "== Sistema de Notas Fiscais: instalação =="

# 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  echo "-> Instalando o Docker…"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null

# 2. Configuração
if [[ -f .env ]]; then
  echo "-> Usando a configuração existente em deploy/.env"
  DOMINIO="$(grep -E '^DOMINIO=' .env | cut -d= -f2- | tr -d "'")"
  ADMIN_EMAIL="$(grep -E '^ADMIN_EMAIL=' .env | cut -d= -f2- | tr -d "'")"
else
  IP_PUBLICO="$(curl -fsS https://api.ipify.org || true)"
  echo
  echo "Domínio onde o sistema vai ficar (ex.: notas.seuescritorio.com.br)."
  echo "O DNS do domínio precisa apontar para este servidor (${IP_PUBLICO:-IP do servidor})."
  if [[ -n "$IP_PUBLICO" ]]; then
    echo "Sem domínio próprio? Use ${IP_PUBLICO//./-}.sslip.io (endereço gratuito)."
  fi
  read -rp "Domínio: " DOMINIO
  read -rp "E-mail do administrador: " ADMIN_EMAIL
  while true; do
    read -rsp "Senha do administrador (mínimo 8 caracteres): " ADMIN_SENHA; echo
    if [[ ${#ADMIN_SENHA} -lt 8 ]]; then echo "Senha muito curta."; continue; fi
    if [[ "$ADMIN_SENHA" == *"'"* ]]; then echo "Não use aspas simples (') na senha."; continue; fi
    break
  done
  umask 077
  cat > .env <<CONF
DOMINIO=${DOMINIO}
ADMIN_EMAIL=${ADMIN_EMAIL}
ADMIN_SENHA='${ADMIN_SENHA}'
BACKUP_HORA=3
BACKUP_DIAS=30
CONF
  umask 022
  echo "-> Configuração salva em deploy/.env"
fi

# 3. Pasta de dados (banco, anexos e backups), gravável pelo usuário do container (uid 1000)
mkdir -p dados
chown -R 1000:1000 dados

# 4. Firewall: só SSH, HTTP e HTTPS
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
  echo "-> Firewall ativo (portas 22, 80 e 443)"
fi

# 5. Subir
echo "-> Construindo e iniciando (pode levar alguns minutos na primeira vez)…"
docker compose up -d --build

echo "-> Aguardando o sistema responder…"
for _ in $(seq 1 30); do
  if docker compose exec -T app wget -qO- http://127.0.0.1:3000/api/saude >/dev/null 2>&1; then
    # O administrador já foi criado: a senha não precisa mais ficar guardada no servidor.
    sed -i '/^ADMIN_SENHA=/d' .env
    echo
    echo "Pronto! Acesse: https://${DOMINIO}"
    echo "Login: ${ADMIN_EMAIL} (a senha que você definiu)."
    echo "O certificado HTTPS pode levar 1 a 2 minutos para ser emitido no primeiro acesso."
    exit 0
  fi
  sleep 2
done
echo "O sistema não respondeu a tempo. Veja os registros com:  docker compose -f deploy/docker-compose.yml logs" >&2
exit 1
