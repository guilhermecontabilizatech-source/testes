'use strict';

// Backup manual: npm run backup (usa as mesmas variáveis DATA_DIR / BACKUP_DIR do servidor).
const path = require('node:path');
const { abrirBanco } = require('../src/db');
const { fazerBackup } = require('../src/backup');

const pastaDados = process.env.DATA_DIR ?? path.join(__dirname, '..', 'data');
const pastaBackup = process.env.BACKUP_DIR ?? path.join(pastaDados, 'backups');

const db = abrirBanco(path.join(pastaDados, 'notas.db'));
fazerBackup({ db, pastaDados, pastaBackup, manterDias: Number(process.env.BACKUP_DIAS ?? 30) })
  .then((r) => console.log(`Backup salvo em ${r.destino} (${r.anexosCopiados} anexo(s) novo(s))`))
  .catch((err) => { console.error('Falha no backup:', err); process.exitCode = 1; })
  .finally(() => db.close());
