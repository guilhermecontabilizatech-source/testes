'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { abrirBanco } = require('../src/db');
const { criarApp } = require('../src/app');
const { gerarHash } = require('../src/auth');

let servidor;
let base;
let pasta;
let db;

test.before(async () => {
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'notas-adm-'));
  db = abrirBanco(':memory:');
  db.prepare("INSERT INTO usuarios (nome, email, senha_hash, papel, admin) VALUES ('Chefe', 'chefe@x.com', ?, 'escritorio', 1)").run(gerarHash('senha-chefe'));
  db.prepare("INSERT INTO usuarios (nome, email, senha_hash, papel) VALUES ('Equipe', 'equipe@x.com', ?, 'escritorio')").run(gerarHash('senha-equipe'));
  servidor = http.createServer(criarApp({ db, pastaArquivos: pasta }));
  await new Promise((r) => servidor.listen(0, r));
  base = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(() => {
  servidor.close();
  fs.rmSync(pasta, { recursive: true, force: true });
});

async function entrar(email, senha) {
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, senha }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return async (metodo, caminho, dados) => {
    const resp = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers: { Cookie: cookie, ...(dados ? { 'Content-Type': 'application/json' } : {}) },
      body: dados ? JSON.stringify(dados) : undefined,
    });
    return { status: resp.status, corpo: await resp.json() };
  };
}

const CNPJS = ['11222333000181', '11444777000161', '45723174000110', '04252011000110'];

test('exclusão em lote: só administrador, com prévia e confirmação EXCLUIR', async () => {
  const chefe = await entrar('chefe@x.com', 'senha-chefe');
  const equipe = await entrar('equipe@x.com', 'senha-equipe');
  assert.equal((await chefe('GET', '/api/me')).corpo.admin, 1);

  const ids = [];
  for (const [i, cnpj] of CNPJS.entries()) ids.push((await chefe('POST', '/api/empresas', { razao_social: `Empresa ${i}`, cnpj })).corpo.id);
  await chefe('POST', '/api/notas-emitidas', {
    empresa_id: ids[0], numero_nota: '1', data_emissao: '2026-10-05',
    arquivos: [{ nome_arquivo: 'n.pdf', tipo_mime: 'application/pdf', conteudo_base64: Buffer.from('%PDF').toString('base64') }],
  });
  await chefe('POST', '/api/ocorrencias', { empresa_id: ids[1], tipo: 'multa', data: '2026-10-05', motivo: 'falta_declaracao', causa: 'cliente' });

  const lote = ids.slice(0, 3);
  assert.equal((await equipe('POST', '/api/empresas/excluir-lote/previa', { ids: lote })).status, 403);
  assert.equal((await equipe('POST', '/api/empresas/excluir-lote', { ids: lote, confirmacao: 'EXCLUIR' })).status, 403);

  let r = await chefe('POST', '/api/empresas/excluir-lote/previa', { ids: lote });
  assert.deepEqual(r.corpo, { empresas: 3, notas: 1, ocorrencias: 1, arquivos: 1, usuarios: 0 });
  r = await chefe('POST', '/api/empresas/excluir-lote', { ids: lote });
  assert.equal(r.status, 409, 'sem confirmação');
  r = await chefe('POST', '/api/empresas/excluir-lote', { ids: [...lote, 99999], confirmacao: 'EXCLUIR' });
  assert.equal(r.status, 409, 'id inexistente');

  r = await chefe('POST', '/api/empresas/excluir-lote', { ids: lote, confirmacao: 'EXCLUIR' });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.empresas, 3);
  assert.deepEqual((await chefe('GET', '/api/empresas')).corpo.map((e) => e.id), [ids[3]]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM solicitacoes').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ocorrencias').get().n, 0);
  assert.equal(fs.readdirSync(pasta).length, 0, 'arquivo apagado do disco');
});

test('perfil de administrador: só administrador concede, ninguém remove o próprio, sempre sobra um', async () => {
  const chefe = await entrar('chefe@x.com', 'senha-chefe');
  const equipe = await entrar('equipe@x.com', 'senha-equipe');
  const idChefe = db.prepare("SELECT id FROM usuarios WHERE email = 'chefe@x.com'").get().id;
  const idEquipe = db.prepare("SELECT id FROM usuarios WHERE email = 'equipe@x.com'").get().id;

  assert.equal((await equipe('PUT', `/api/usuarios/${idEquipe}`, { nome: 'Equipe', ativo: true, admin: true })).status, 403);
  assert.match((await chefe('PUT', `/api/usuarios/${idChefe}`, { nome: 'Chefe', ativo: true, admin: false })).corpo.erro, /próprio/);

  // Usuário criado por quem não é administrador nunca nasce administrador.
  await equipe('POST', '/api/usuarios', { nome: 'Novo', email: 'novo@x.com', senha: 'senha-novo1', admin: true });
  assert.equal(db.prepare("SELECT admin FROM usuarios WHERE email = 'novo@x.com'").get().admin, 0);

  assert.equal((await chefe('PUT', `/api/usuarios/${idEquipe}`, { nome: 'Equipe', ativo: true, admin: true })).status, 200);
  assert.equal((await chefe('GET', '/api/usuarios')).corpo.find((u) => u.id === idEquipe).admin, 1);

  // Não dá para desativar o último administrador.
  await chefe('PUT', `/api/usuarios/${idEquipe}`, { nome: 'Equipe', ativo: true, admin: false });
  const outroChefe = await entrar('equipe@x.com', 'senha-equipe');
  assert.equal((await outroChefe('PUT', `/api/usuarios/${idChefe}`, { nome: 'Chefe', ativo: false })).status, 400);
});

test('banco existente: o primeiro usuário da equipe vira administrador', () => {
  const arquivo = path.join(pasta, 'existente.db');
  const antigo = abrirBanco(arquivo);
  antigo.prepare("INSERT INTO usuarios (nome, email, senha_hash, papel) VALUES ('Primeiro', 'p@x.com', 'h', 'escritorio')").run();
  antigo.prepare("INSERT INTO usuarios (nome, email, senha_hash, papel) VALUES ('Segundo', 's@x.com', 'h', 'escritorio')").run();
  antigo.close();
  const reaberto = abrirBanco(arquivo);
  assert.deepEqual(reaberto.prepare('SELECT email, admin FROM usuarios ORDER BY id').all().map((u) => [u.email, u.admin]), [['p@x.com', 1], ['s@x.com', 0]]);
  reaberto.close();
});
