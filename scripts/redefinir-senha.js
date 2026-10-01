'use strict';

// Redefine a senha de um usuário pelo terminal do servidor:
//   docker compose exec app node scripts/redefinir-senha.js email@exemplo.com 'nova-senha'
const path = require('node:path');
const { abrirBanco } = require('../src/db');
const { gerarHash } = require('../src/auth');

const [email, senha] = process.argv.slice(2);
if (!email || !senha || senha.length < 8) {
  console.error("Uso: node scripts/redefinir-senha.js email@exemplo.com 'nova-senha' (mínimo 8 caracteres)");
  process.exit(1);
}

const pastaDados = process.env.DATA_DIR ?? path.join(__dirname, '..', 'data');
const db = abrirBanco(path.join(pastaDados, 'notas.db'));
const usuario = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email);
if (!usuario) {
  console.error(`Nenhum usuário com o e-mail ${email}.`);
  process.exitCode = 1;
} else {
  db.prepare('UPDATE usuarios SET senha_hash = ?, ativo = 1 WHERE id = ?').run(gerarHash(senha), usuario.id);
  db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(usuario.id);
  console.log(`Senha de ${email} redefinida.`);
}
db.close();
