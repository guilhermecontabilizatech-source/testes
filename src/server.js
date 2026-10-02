'use strict';

const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { abrirBanco } = require('./db');
const { criarApp } = require('./app');
const { gerarHash } = require('./auth');
const { fazerBackup, msAte } = require('./backup');

const PORTA = Number(process.env.PORT ?? 3000);
const PASTA_DADOS = process.env.DATA_DIR ?? path.join(__dirname, '..', 'data');
const PASTA_BACKUP = process.env.BACKUP_DIR ?? path.join(PASTA_DADOS, 'backups');
const BACKUP_DIAS = Number(process.env.BACKUP_DIAS ?? 30);
const BACKUP_HORA = Number(process.env.BACKUP_HORA ?? 3); // horário de Brasília

const db = abrirBanco(path.join(PASTA_DADOS, 'notas.db'));

// Na primeira execução, cria o usuário administrador do escritório.
const totalUsuarios = db.prepare('SELECT COUNT(*) AS n FROM usuarios').get().n;
if (totalUsuarios === 0) {
  const email = process.env.ADMIN_EMAIL ?? 'admin@escritorio.com.br';
  const senha = process.env.ADMIN_SENHA ?? crypto.randomBytes(9).toString('base64url');
  db.prepare("INSERT INTO usuarios (nome, email, senha_hash, papel, admin) VALUES (?, ?, ?, 'escritorio', 1)")
    .run('Administrador', email, gerarHash(senha));
  console.log('Usuário administrador criado:');
  console.log(`  e-mail: ${email}`);
  if (!process.env.ADMIN_SENHA) console.log(`  senha:  ${senha}  (troque após o primeiro acesso)`);
}

const app = criarApp({
  db,
  pastaArquivos: path.join(PASTA_DADOS, 'anexos'),
  cookieSeguro: process.env.COOKIE_SEGURO === '1',
  confiarProxy: process.env.CONFIAR_PROXY === '1',
  acessoClientes: process.env.ACESSO_CLIENTES === '1',
  portalClientes: process.env.PORTAL_CLIENTES === '1',
  zenWebhookToken: process.env.ZEN_WEBHOOK_TOKEN || null,
});

// Limpa sessões expiradas a cada hora.
setInterval(() => db.prepare("DELETE FROM sessoes WHERE expira_em < ?").run(new Date().toISOString()), 60 * 60 * 1000).unref();

// Backup diário automático (desligue com BACKUP_DIAS=0).
async function backupDiario() {
  try {
    const r = await fazerBackup({ db, pastaDados: PASTA_DADOS, pastaBackup: PASTA_BACKUP, manterDias: BACKUP_DIAS });
    console.log(`Backup concluído: ${r.destino} (${r.anexosCopiados} anexo(s) novo(s), ${r.removidos} cópia(s) antiga(s) removida(s))`);
  } catch (err) {
    console.error('Falha no backup:', err);
  }
  agendarBackup();
}
function agendarBackup() {
  setTimeout(backupDiario, msAte(BACKUP_HORA)).unref();
}
if (BACKUP_DIAS > 0) agendarBackup();

const servidor = http.createServer(app).listen(PORTA, () => {
  console.log(`Sistema de notas fiscais rodando em http://localhost:${PORTA}`);
});

// Encerramento limpo (ex.: atualização do container): termina as requisições e fecha o banco.
function encerrar(sinal) {
  console.log(`Recebido ${sinal}, encerrando…`);
  servidor.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => encerrar('SIGTERM'));
process.on('SIGINT', () => encerrar('SIGINT'));
