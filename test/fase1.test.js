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
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'notas-f1-'));
  db = abrirBanco(':memory:');
  db.prepare("INSERT INTO usuarios (nome, email, senha_hash, papel) VALUES ('Ana', 'ana@x.com', ?, 'escritorio')").run(gerarHash('senha-ana1'));
  db.prepare("INSERT INTO usuarios (nome, email, senha_hash, papel) VALUES ('Bia', 'bia@x.com', ?, 'escritorio')").run(gerarHash('senha-bia1'));
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
  const cookie = r.headers.get('set-cookie')?.split(';')[0];
  const chamar = async (metodo, caminho, dados) => {
    const resp = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers: { Cookie: cookie, ...(dados ? { 'Content-Type': 'application/json' } : {}) },
      body: dados ? JSON.stringify(dados) : undefined,
    });
    const tipo = resp.headers.get('content-type') ?? '';
    return { status: resp.status, corpo: tipo.includes('json') ? await resp.json() : await resp.text() };
  };
  chamar.status = r.status;
  return chamar;
}

test('notas registradas pelo escritório: só número e data, canal do pedido, edição e exclusão', async () => {
  const ana = await entrar('ana@x.com', 'senha-ana1');
  const anaId = db.prepare("SELECT id FROM usuarios WHERE email = 'ana@x.com'").get().id;
  const empresa = (await ana('POST', '/api/empresas', {
    razao_social: 'Padaria', cnpj: '11222333000181', honorario: '600,00', responsavel_id: anaId,
  })).corpo.id;
  await ana('POST', '/api/empresas', { razao_social: 'Outra', cnpj: '11444777000161' });

  // Só número e data, sem anexo.
  let r = await ana('POST', '/api/notas-emitidas', { empresa_id: empresa, numero_nota: '101', data_emissao: '2026-10-05', canal_pedido: 'whatsapp', data_pedido: '2026-10-03' });
  assert.equal(r.status, 200);
  const nota = r.corpo.id;
  r = await ana('POST', '/api/notas-emitidas', { empresa_id: empresa, numero_nota: '102', data_emissao: '2026-10-05', canal_pedido: 'outro' });
  assert.match(r.corpo.erro, /Descrição do canal/);
  r = await ana('POST', '/api/notas-emitidas', { empresa_id: empresa, numero_nota: '102', data_emissao: '2026-10-05', canal_pedido: 'outro', canal_outro: 'Instagram' });
  assert.equal(r.status, 200);
  r = await ana('POST', '/api/notas-emitidas', { empresa_id: empresa, numero_nota: '103', data_emissao: '2026-10-05', data_pedido: '2026-10-09' });
  assert.match(r.corpo.erro, /data do pedido/);
  r = await ana('POST', '/api/notas-emitidas', { empresa_id: empresa, numero_nota: '101', data_emissao: '2026-10-06' });
  assert.equal(r.status, 409, 'número repetido');

  r = await ana('GET', `/api/solicitacoes?empresa_id=${empresa}&mes=2026-10`);
  assert.deepEqual(r.corpo.map((s) => [s.numero_nota, s.canal_pedido, s.canal_outro]), [['102', 'outro', 'Instagram'], ['101', 'whatsapp', null]].sort((a, b) => b[0].localeCompare(a[0])));
  assert.equal(r.corpo.find((s) => s.numero_nota === '101').data_pedido, '2026-10-03');

  // Edição muda a data: a nota passa a contar em novembro.
  r = await ana('PUT', `/api/notas-emitidas/${nota}`, { numero_nota: '101', data_emissao: '2026-11-02', valor: '150,00', canal_pedido: 'email' });
  assert.equal(r.status, 200);
  r = await ana('GET', `/api/relatorio?empresa_id=${empresa}`);
  assert.deepEqual(r.corpo.empresas[0].notas.por_mes, { '2026-10': 1, '2026-11': 1, '2026-12': 0 });

  // Honorário por demanda: 600 × 3 meses / 2 notas = 900,00.
  assert.equal(r.corpo.empresas[0].demandas, 2);
  assert.equal(r.corpo.empresas[0].honorario_por_demanda_centavos, 90000);

  // Filtro por responsável.
  const biaId = db.prepare("SELECT id FROM usuarios WHERE email = 'bia@x.com'").get().id;
  assert.equal((await ana('GET', `/api/relatorio?responsavel_id=${anaId}`)).corpo.empresas.length, 1);
  assert.equal((await ana('GET', `/api/relatorio?responsavel_id=${biaId}`)).corpo.empresas.length, 0);
  assert.equal((await ana('GET', '/api/empresas')).corpo.find((e) => e.id === empresa).responsavel_nome, 'Ana');

  r = await ana('DELETE', `/api/solicitacoes/${nota}`, {});
  assert.equal(r.status, 200);
  assert.equal((await ana('GET', `/api/solicitacoes?empresa_id=${empresa}`)).corpo.length, 1);
});

test('"Outro" exige descrição e é agrupado pelo texto no relatório', async () => {
  const ana = await entrar('ana@x.com', 'senha-ana1');
  const empresa = db.prepare("SELECT id FROM empresas WHERE cnpj = '11222333000181'").get().id;
  const base = { empresa_id: empresa, tipo: 'multa', data: '2026-10-10', causa: 'cliente' };
  let r = await ana('POST', '/api/ocorrencias', { ...base, motivo: 'outro' });
  assert.match(r.corpo.erro, /Motivo: outro/);
  r = await ana('POST', '/api/ocorrencias', { ...base, motivo: 'falta_declaracao', causa: 'outro' });
  assert.match(r.corpo.erro, /Causa: outro/);
  r = await ana('POST', '/api/ocorrencias', { ...base, motivo: 'falta_declaracao', tributo: 'outro' });
  assert.match(r.corpo.erro, /Tributo: outro/);

  for (const texto of ['Multa da junta comercial', 'multa da junta comercial ']) {
    r = await ana('POST', '/api/ocorrencias', { ...base, motivo: 'outro', motivo_outro: texto, tributo: 'outro', tributo_outro: 'Taxa municipal' });
    assert.equal(r.status, 200);
  }
  const lista = (await ana('GET', `/api/ocorrencias?empresa_id=${empresa}`)).corpo;
  assert.equal(lista[0].tributo_outro, 'Taxa municipal');
  const rel = (await ana('GET', '/api/relatorio')).corpo;
  assert.deepEqual(rel.totais.por_motivo.map((m) => [m.rotulo, m.quantidade]), [['Outro: Multa da junta comercial', 2]]);
});

test('acesso de clientes desativado por padrão', async () => {
  const empresa = db.prepare('SELECT id FROM empresas LIMIT 1').get().id;
  db.prepare("INSERT INTO usuarios (nome, email, senha_hash, papel, empresa_id) VALUES ('Cli', 'cli@x.com', ?, 'cliente', ?)").run(gerarHash('senha-cli1'), empresa);
  const cliente = await entrar('cli@x.com', 'senha-cli1');
  assert.equal(cliente.status, 403);
  const ana = await entrar('ana@x.com', 'senha-ana1');
  const r = await ana('POST', '/api/usuarios', { nome: 'Novo', email: 'novo@x.com', senha: 'senha-novo', papel: 'cliente', empresa_id: empresa });
  assert.match(r.corpo.erro, /acesso de clientes/);
  assert.deepEqual((await ana('GET', '/api/opcoes')).corpo.acesso_clientes, false);
});
