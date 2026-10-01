'use strict';

const crypto = require('node:crypto');

const DURACAO_SESSAO_MS = 12 * 60 * 60 * 1000;
const NOME_COOKIE = 'sessao';

function gerarHash(senha) {
  const sal = crypto.randomBytes(16);
  const hash = crypto.scryptSync(senha, sal, 64);
  return `scrypt$${sal.toString('hex')}$${hash.toString('hex')}`;
}

function conferirSenha(senha, armazenado) {
  const [algoritmo, salHex, hashHex] = String(armazenado).split('$');
  if (algoritmo !== 'scrypt' || !salHex || !hashHex) return false;
  const esperado = Buffer.from(hashHex, 'hex');
  const calculado = crypto.scryptSync(senha, Buffer.from(salHex, 'hex'), esperado.length);
  return crypto.timingSafeEqual(esperado, calculado);
}

function criarSessao(db, usuarioId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + DURACAO_SESSAO_MS).toISOString();
  db.prepare('INSERT INTO sessoes (token, usuario_id, expira_em) VALUES (?, ?, ?)').run(token, usuarioId, expira);
  return token;
}

function encerrarSessao(db, token) {
  db.prepare('DELETE FROM sessoes WHERE token = ?').run(token);
}

function usuarioDaSessao(db, token) {
  if (!token) return null;
  const linha = db.prepare(`
    SELECT u.id, u.nome, u.email, u.papel, u.empresa_id, s.expira_em
    FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
    WHERE s.token = ? AND u.ativo = 1
  `).get(token);
  if (!linha) return null;
  if (new Date(linha.expira_em) < new Date()) {
    encerrarSessao(db, token);
    return null;
  }
  const { expira_em, ...usuario } = linha;
  return { ...usuario };
}

function lerCookies(cabecalho) {
  const cookies = {};
  for (const parte of String(cabecalho ?? '').split(';')) {
    const i = parte.indexOf('=');
    if (i > 0) cookies[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
  }
  return cookies;
}

function cookieSessao(token, { seguro = false } = {}) {
  const atributos = [
    `${NOME_COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${token ? DURACAO_SESSAO_MS / 1000 : 0}`,
  ];
  if (seguro) atributos.push('Secure');
  return atributos.join('; ');
}

module.exports = {
  NOME_COOKIE,
  gerarHash,
  conferirSenha,
  criarSessao,
  encerrarSessao,
  usuarioDaSessao,
  lerCookies,
  cookieSessao,
};
