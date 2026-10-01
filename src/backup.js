'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite = require('node:sqlite');

// Cópia de segurança: o banco é copiado com a API de backup do SQLite (segura com o
// sistema em uso) e os anexos novos são copiados para a pasta de backup.
async function fazerBackup({ db, pastaDados, pastaBackup, manterDias = 30, agora = new Date() }) {
  fs.mkdirSync(pastaBackup, { recursive: true });
  const carimbo = agora.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const destino = path.join(pastaBackup, `notas-${carimbo}.db`);
  await sqlite.backup(db, destino);

  const anexosOrigem = path.join(pastaDados, 'anexos');
  const anexosDestino = path.join(pastaBackup, 'anexos');
  fs.mkdirSync(anexosDestino, { recursive: true });
  let anexosCopiados = 0;
  if (fs.existsSync(anexosOrigem)) {
    for (const nome of fs.readdirSync(anexosOrigem)) {
      const alvo = path.join(anexosDestino, nome);
      if (!fs.existsSync(alvo)) {
        fs.copyFileSync(path.join(anexosOrigem, nome), alvo);
        anexosCopiados++;
      }
    }
  }

  // Remove cópias do banco mais antigas que o prazo (anexos são mantidos).
  const limite = agora.getTime() - manterDias * 24 * 60 * 60 * 1000;
  let removidos = 0;
  for (const nome of fs.readdirSync(pastaBackup)) {
    if (!/^notas-.*\.db$/.test(nome)) continue;
    const arquivo = path.join(pastaBackup, nome);
    if (fs.statSync(arquivo).mtimeMs < limite) {
      fs.rmSync(arquivo);
      removidos++;
    }
  }
  return { destino, anexosCopiados, removidos };
}

// Milissegundos até a próxima ocorrência de "hora" (0–23) no horário de Brasília (UTC-3).
function msAte(hora, agora = Date.now()) {
  const proxima = new Date(agora);
  proxima.setUTCHours(hora + 3, 0, 0, 0); // pode passar de 24h e cair no dia seguinte
  while (proxima.getTime() - agora > 24 * 60 * 60 * 1000) proxima.setUTCDate(proxima.getUTCDate() - 1);
  while (proxima.getTime() <= agora) proxima.setUTCDate(proxima.getUTCDate() + 1);
  return proxima.getTime() - agora;
}

module.exports = { fazerBackup, msAte };
