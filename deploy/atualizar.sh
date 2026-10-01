#!/usr/bin/env bash
# Baixa a versão mais nova do código e reinicia o sistema, sem perder dados. Uso:
#   sudo bash deploy/atualizar.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "-> Fazendo backup antes de atualizar…"
docker compose exec -T app node --disable-warning=ExperimentalWarning scripts/backup.js

echo "-> Baixando atualizações…"
git -C .. pull --ff-only

echo "-> Reconstruindo e reiniciando…"
docker compose up -d --build
docker compose ps
echo "Atualização concluída."
