'use strict';

const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { abrirBanco } = require('./db');
const { criarApp } = require('./app');
const { gerarHash } = require('./auth');

const PORTA = Number(process.env.PORT ?? 3000);
const PASTA_DADOS = process.env.DATA_DIR ?? path.join(__dirname, '..', 'data');

const db = abrirBanco(path.join(PASTA_DADOS, 'notas.db'));

// Na primeira execução, cria o usuário administrador do escritório.
const totalUsuarios = db.prepare('SELECT COUNT(*) AS n FROM usuarios').get().n;
if (totalUsuarios === 0) {
  const email = process.env.ADMIN_EMAIL ?? 'admin@escritorio.com.br';
  const senha = process.env.ADMIN_SENHA ?? crypto.randomBytes(9).toString('base64url');
  db.prepare("INSERT INTO usuarios (nome, email, senha_hash, papel) VALUES (?, ?, ?, 'escritorio')")
    .run('Administrador', email, gerarHash(senha));
  console.log('Usuário administrador criado:');
  console.log(`  e-mail: ${email}`);
  if (!process.env.ADMIN_SENHA) console.log(`  senha:  ${senha}  (troque após o primeiro acesso)`);
}

const app = criarApp({
  db,
  pastaArquivos: path.join(PASTA_DADOS, 'anexos'),
  cookieSeguro: process.env.COOKIE_SEGURO === '1',
});

// Limpa sessões expiradas a cada hora.
setInterval(() => db.prepare("DELETE FROM sessoes WHERE expira_em < ?").run(new Date().toISOString()), 60 * 60 * 1000).unref();

http.createServer(app).listen(PORTA, () => {
  console.log(`Sistema de notas fiscais rodando em http://localhost:${PORTA}`);
});
