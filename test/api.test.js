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

test.before(async () => {
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'notas-'));
  const db = abrirBanco(':memory:');
  db.prepare("INSERT INTO usuarios (nome, email, senha_hash, papel) VALUES ('Admin', 'admin@x.com', ?, 'escritorio')")
    .run(gerarHash('senha-admin'));
  servidor = http.createServer(criarApp({ db, pastaArquivos: pasta }));
  await new Promise((r) => servidor.listen(0, r));
  base = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(() => {
  servidor.close();
  fs.rmSync(pasta, { recursive: true, force: true });
});

async function entrar(email, senha) {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, senha }),
  });
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return async (metodo, caminho, dados) => {
    const resp = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers: { Cookie: cookie, ...(dados ? { 'Content-Type': 'application/json' } : {}) },
      body: dados ? JSON.stringify(dados) : undefined,
    });
    const tipo = resp.headers.get('content-type') ?? '';
    return { status: resp.status, corpo: tipo.includes('json') ? await resp.json() : await resp.text() };
  };
}

const solicitacao = {
  tipo_nota: 'NFS-e',
  tomador_documento: '529.982.247-25',
  tomador_nome: 'Maria Tomadora',
  descricao: 'Serviço de consultoria contábil',
  valor: '2.500,00',
  data_competencia: '2026-09-15',
};

test('fluxo completo: cadastro, solicitação, emissão e anexo', async () => {
  const admin = await entrar('admin@x.com', 'senha-admin');

  const anonimo = await fetch(`${base}/api/solicitacoes`);
  assert.equal(anonimo.status, 401);

  let r = await admin('POST', '/api/empresas', { razao_social: 'Padaria Boa', cnpj: '11.222.333/0001-81' });
  assert.equal(r.status, 200);
  const empresaA = r.corpo.id;
  r = await admin('POST', '/api/empresas', { razao_social: 'Outra Ltda', cnpj: '11.444.777/0001-61' });
  const empresaB = r.corpo.id;
  r = await admin('POST', '/api/empresas', { razao_social: 'Dup', cnpj: '11222333000181' });
  assert.equal(r.status, 409);

  r = await admin('POST', '/api/usuarios', { nome: 'Cliente A', email: 'a@cliente.com', senha: 'senha-cliente', papel: 'cliente', empresa_id: empresaA });
  assert.equal(r.status, 200);
  await admin('POST', '/api/usuarios', { nome: 'Cliente B', email: 'b@cliente.com', senha: 'senha-cliente', papel: 'cliente', empresa_id: empresaB });

  const clienteA = await entrar('a@cliente.com', 'senha-cliente');
  const clienteB = await entrar('b@cliente.com', 'senha-cliente');

  // Cliente não acessa área do escritório.
  assert.equal((await clienteA('GET', '/api/empresas')).status, 403);

  // Cliente cria solicitação (empresa_id enviado é ignorado: usa a do usuário).
  r = await clienteA('POST', '/api/solicitacoes', { ...solicitacao, empresa_id: empresaB });
  assert.equal(r.status, 200);
  const id = r.corpo.id;
  r = await clienteA('GET', `/api/solicitacoes/${id}`);
  assert.equal(r.corpo.empresa_id, empresaA);
  assert.equal(r.corpo.valor_centavos, 250000);
  assert.equal(r.corpo.status, 'pendente');
  assert.deepEqual(r.corpo.transicoes, ['cancelada']);

  // Outra empresa não enxerga a solicitação.
  assert.equal((await clienteB('GET', `/api/solicitacoes/${id}`)).status, 404);
  assert.equal((await clienteB('GET', '/api/solicitacoes')).corpo.length, 0);

  // Cliente não pode emitir.
  r = await clienteA('POST', `/api/solicitacoes/${id}/status`, { status: 'em_emissao' });
  assert.equal(r.status, 403);

  // Escritório rejeita, cliente corrige e volta a pendente.
  r = await admin('POST', `/api/solicitacoes/${id}/status`, { status: 'rejeitada' });
  assert.equal(r.status, 400, 'rejeição exige motivo');
  r = await admin('POST', `/api/solicitacoes/${id}/status`, { status: 'rejeitada', mensagem: 'Falta o endereço do tomador' });
  assert.equal(r.status, 200);
  r = await clienteA('PUT', `/api/solicitacoes/${id}`, { ...solicitacao, tomador_endereco: 'Rua A, 10' });
  assert.equal(r.status, 200);
  r = await clienteA('GET', `/api/solicitacoes/${id}`);
  assert.equal(r.corpo.status, 'pendente');
  assert.equal(r.corpo.motivo_rejeicao, null);

  // Escritório emite.
  assert.equal((await admin('POST', `/api/solicitacoes/${id}/status`, { status: 'em_emissao' })).status, 200);
  assert.equal((await admin('POST', `/api/solicitacoes/${id}/status`, { status: 'emitida' })).status, 400, 'exige número');
  r = await admin('POST', `/api/solicitacoes/${id}/status`, { status: 'emitida', numero_nota: '2026/123' });
  assert.equal(r.status, 200);

  // Após emitida, cliente não edita.
  assert.equal((await clienteA('PUT', `/api/solicitacoes/${id}`, solicitacao)).status, 409);

  // Escritório anexa o PDF; cliente baixa; outra empresa não.
  r = await admin('POST', `/api/solicitacoes/${id}/anexos`, {
    nome_arquivo: 'nota.pdf', tipo_mime: 'application/pdf', conteudo_base64: Buffer.from('%PDF-1.4 teste').toString('base64'),
  });
  assert.equal(r.status, 200);
  const anexoId = r.corpo.id;
  r = await admin('POST', `/api/solicitacoes/${id}/anexos`, {
    nome_arquivo: 'x.exe', tipo_mime: 'application/x-msdownload', conteudo_base64: 'AAAA',
  });
  assert.equal(r.status, 400);
  r = await clienteA('GET', `/api/anexos/${anexoId}`);
  assert.equal(r.status, 200);
  assert.equal(r.corpo, '%PDF-1.4 teste');
  assert.equal((await clienteB('GET', `/api/anexos/${anexoId}`)).status, 404);

  // Histórico registra tudo.
  r = await clienteA('GET', `/api/solicitacoes/${id}`);
  assert.deepEqual(r.corpo.historico.map((h) => h.acao),
    ['criada', 'status:rejeitada', 'editada', 'status:em_emissao', 'status:emitida', 'anexo']);
  assert.equal(r.corpo.numero_nota, '2026/123');

  // Resumo e CSV.
  r = await admin('GET', '/api/resumo');
  assert.equal(r.corpo.emitida.quantidade, 1);
  assert.equal(r.corpo.emitida.total_centavos, 250000);
  r = await admin('GET', '/api/solicitacoes.csv?status=emitida');
  assert.match(r.corpo, /Padaria Boa;NFS-e;Maria Tomadora;52998224725;2500,00/);
});

test('cancelamento pelo cliente exige motivo e encerra a solicitação', async () => {
  const admin = await entrar('admin@x.com', 'senha-admin');
  const cliente = await entrar('a@cliente.com', 'senha-cliente');
  const { corpo } = await cliente('POST', '/api/solicitacoes', solicitacao);
  assert.equal((await cliente('POST', `/api/solicitacoes/${corpo.id}/status`, { status: 'cancelada' })).status, 400);
  assert.equal((await cliente('POST', `/api/solicitacoes/${corpo.id}/status`, { status: 'cancelada', mensagem: 'Cliente desistiu' })).status, 200);
  assert.equal((await admin('POST', `/api/solicitacoes/${corpo.id}/status`, { status: 'em_emissao' })).status, 409);
});

test('usuário desativado perde a sessão', async () => {
  const admin = await entrar('admin@x.com', 'senha-admin');
  const usuarios = (await admin('GET', '/api/usuarios')).corpo;
  const b = usuarios.find((u) => u.email === 'b@cliente.com');
  const clienteB = await entrar('b@cliente.com', 'senha-cliente');
  await admin('PUT', `/api/usuarios/${b.id}`, { nome: b.nome, ativo: false });
  assert.equal((await clienteB('GET', '/api/me')).status, 401);
});

test('rejeita POST sem JSON (proteção CSRF) e arquivos fora da pasta pública', async () => {
  const r = await fetch(`${base}/api/login`, { method: 'POST', body: 'email=a&senha=b', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.status, 415);
  const s = await fetch(`${base}/..%2F..%2Fpackage.json`);
  assert.equal(s.status, 404);
  const pagina = await fetch(`${base}/`);
  assert.equal(pagina.status, 200);
});
