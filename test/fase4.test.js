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

const dia = (deslocamento) => new Date(Date.now() - 3 * 3600000 + deslocamento * 86400000).toISOString().slice(0, 10);

test.before(async () => {
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'notas-fase4-'));
  db = abrirBanco(':memory:');
  const inserir = db.prepare('INSERT INTO usuarios (nome, email, senha_hash, papel, admin) VALUES (?, ?, ?, ?, ?)');
  inserir.run('Chefe', 'chefe@x.com', gerarHash('senha-chefe'), 'escritorio', 1);
  inserir.run('Ana', 'ana@x.com', gerarHash('senha-ana1'), 'escritorio', 0);
  servidor = http.createServer(criarApp({ db, pastaArquivos: pasta }));
  await new Promise((r) => servidor.listen(0, r));
  base = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(() => {
  servidor.close();
  fs.rmSync(pasta, { recursive: true, force: true });
});

async function chamar(metodo, caminho, dados, cookie = null) {
  const resp = await fetch(`${base}${caminho}`, {
    method: metodo,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(dados ? { 'Content-Type': 'application/json' } : {}) },
    body: dados ? JSON.stringify(dados) : undefined,
  });
  return { status: resp.status, corpo: await resp.json() };
}

async function entrar(email, senha) {
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, senha }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return (metodo, caminho, dados) => chamar(metodo, caminho, dados, cookie);
}

test('multas: começam pendentes, com vencimento; pagar, contestar e alertar vencidas', async () => {
  const ana = await entrar('ana@x.com', 'senha-ana1');
  const empresa = (await ana('POST', '/api/empresas', { razao_social: 'Cliente', cnpj: '11222333000181' })).corpo.id;
  assert.equal((await ana('POST', '/api/ocorrencias', {
    empresa_id: empresa, tipo: 'multa', data: dia(-10), motivo: 'falta_declaracao', causa: 'cliente', vencimento: '2026-02-30',
  })).status, 400);
  const multa = (await ana('POST', '/api/ocorrencias', {
    empresa_id: empresa, tipo: 'multa', data: dia(-10), motivo: 'falta_declaracao', causa: 'cliente', valor: '200', vencimento: dia(-1),
  })).corpo.id;
  const guia = (await ana('POST', '/api/ocorrencias', {
    empresa_id: empresa, tipo: 'guia_recalculada', data: dia(-3), motivo: 'retificacao', causa: 'cliente', vencimento: dia(5),
  })).corpo.id;

  let lista = (await ana('GET', `/api/ocorrencias?empresa_id=${empresa}`)).corpo;
  assert.equal(lista.find((o) => o.id === multa).situacao, 'pendente');
  const g = lista.find((o) => o.id === guia);
  assert.equal(g.situacao, null);
  assert.equal(g.vencimento, null); // vencimento só vale para multa

  let p = (await ana('GET', '/api/painel')).corpo;
  assert.equal(p.operacao.multas_vencidas, 1);
  assert.ok(p.alertas.some((a) => /multa\(s\) vencida/.test(a.texto)));

  assert.equal((await ana('POST', `/api/ocorrencias/${guia}/situacao`, { situacao: 'paga', pago_em: dia(0) })).status, 400);
  assert.match((await ana('POST', `/api/ocorrencias/${multa}/situacao`, { situacao: 'paga' })).corpo.erro, /data do pagamento/);
  assert.match((await ana('POST', `/api/ocorrencias/${multa}/situacao`, { situacao: 'contestada' })).corpo.erro, /Observação/);
  assert.equal((await ana('POST', `/api/ocorrencias/${multa}/situacao`, { situacao: 'contestada', situacao_obs: 'Processo 123 na Receita' })).status, 200);
  assert.equal((await ana('GET', '/api/ocorrencias?situacao=contestada')).corpo.length, 1);
  assert.equal((await ana('POST', `/api/ocorrencias/${multa}/situacao`, { situacao: 'paga', pago_em: dia(0) })).status, 200);
  lista = (await ana('GET', '/api/ocorrencias?situacao=paga')).corpo;
  assert.equal(lista[0].pago_em, dia(0));
  assert.equal(lista[0].situacao_obs, null);
  p = (await ana('GET', '/api/painel')).corpo;
  assert.equal(p.operacao.multas_vencidas, 0);
});

test('banco antigo: multas sem situação viram pendentes ao abrir', () => {
  const arquivo = path.join(pasta, 'antigo.db');
  const antigo = abrirBanco(arquivo);
  antigo.prepare("INSERT INTO empresas (razao_social, cnpj) VALUES ('X', '11444777000161')").run();
  antigo.prepare("INSERT INTO ocorrencias (empresa_id, tipo, data, motivo, causa) VALUES (1, 'multa', '2026-01-01', 'outro', 'cliente')").run();
  antigo.prepare("INSERT INTO ocorrencias (empresa_id, tipo, data, motivo, causa) VALUES (1, 'guia_recalculada', '2026-01-01', 'outro', 'cliente')").run();
  antigo.close();
  const reaberto = abrirBanco(arquivo);
  assert.deepEqual(reaberto.prepare('SELECT tipo, situacao FROM ocorrencias ORDER BY id').all().map((o) => [o.tipo, o.situacao]),
    [['multa', 'pendente'], ['guia_recalculada', null]]);
  reaberto.close();
});

test('pesquisas: link público, uma resposta, expiração e NPS', async () => {
  const ana = await entrar('ana@x.com', 'senha-ana1');
  const chefe = await entrar('chefe@x.com', 'senha-chefe');
  const empresas = (await ana('GET', '/api/empresas')).corpo;
  const empresa = empresas[0].id;
  await ana('POST', '/api/empresas', { razao_social: 'Outra', nome_fantasia: 'Loja da Outra', cnpj: '45723174000110' });
  await ana('POST', '/api/empresas', { razao_social: 'Inativa', cnpj: '04252011000110', ativo: false });

  assert.equal((await ana('POST', '/api/pesquisas', { empresa_id: empresa, validade_dias: 0 })).status, 400);
  assert.equal((await ana('POST', '/api/pesquisas', { empresa_id: empresa, tipo: 'xpto' })).status, 400);
  const { id, token } = (await ana('POST', '/api/pesquisas', { empresa_id: empresa })).corpo;
  assert.ok(token.length >= 30);

  // Sem login: abre e responde.
  assert.equal((await chamar('GET', '/api/pesquisa-publica/codigo-que-nao-existe-1234')).status, 404);
  assert.equal((await chamar('GET', '/api/pesquisa-publica/curto')).status, 404);
  const publica = (await chamar('GET', `/api/pesquisa-publica/${token}`)).corpo;
  assert.equal(publica.pede_nps, true);
  assert.equal(Object.keys(publica.dimensoes).length, 4);
  assert.equal(publica.respondida, false);
  assert.equal(publica.empresa_nome, 'Cliente');

  assert.match((await chamar('POST', `/api/pesquisa-publica/${token}`, { nps: 9 })).corpo.erro, /Responda/);
  assert.equal((await chamar('POST', `/api/pesquisa-publica/${token}`, {
    nps: 11, csat_atendimento: 5, csat_prazo: 5, csat_qualidade: 5, csat_comunicacao: 5,
  })).status, 400);
  const resposta = { nps: 10, csat_atendimento: 5, csat_prazo: 4, csat_qualidade: 5, csat_comunicacao: 3, comentario: 'Muito bom!' };
  assert.equal((await chamar('POST', `/api/pesquisa-publica/${token}`, resposta)).status, 200);
  assert.equal((await chamar('POST', `/api/pesquisa-publica/${token}`, resposta)).status, 409);
  assert.equal((await chamar('GET', `/api/pesquisa-publica/${token}`)).corpo.respondida, true);

  // Só NPS, para a outra empresa; detrator.
  const outra = empresas.length ? (await ana('GET', '/api/empresas')).corpo.find((e) => e.razao_social === 'Outra').id : null;
  const so = (await ana('POST', '/api/pesquisas', { empresa_id: outra, tipo: 'nps' })).corpo;
  assert.equal((await chamar('GET', `/api/pesquisa-publica/${so.token}`)).corpo.empresa_nome, 'Loja da Outra');
  assert.equal((await chamar('POST', `/api/pesquisa-publica/${so.token}`, { nps: 4 })).status, 200);

  // Link expirado.
  const exp = (await ana('POST', '/api/pesquisas', { empresa_id: outra })).corpo;
  db.prepare('UPDATE pesquisas SET expira_em = ? WHERE id = ?').run(dia(-1), exp.id);
  assert.equal((await chamar('POST', `/api/pesquisa-publica/${exp.token}`, { nps: 10 })).status, 410);

  const r = (await ana('GET', '/api/pesquisas')).corpo;
  assert.equal(r.resumo.respostas, 2);
  assert.equal(r.resumo.nps, 0); // 1 promotor, 1 detrator
  assert.equal(r.resumo.csat.csat_prazo, 4);
  assert.equal(r.resumo.taxa_resposta, 67);
  assert.equal(r.aguardando.length, 1);
  assert.equal(r.aguardando[0].expirada, true);
  assert.equal(r.respostas.find((x) => x.id === id).comentario, 'Muito bom!');

  // Lote: só ativos sem pesquisa válida aguardando (a "Outra" tem só um link expirado).
  assert.deepEqual((await ana('POST', '/api/pesquisas/lote', {})).corpo, { criadas: 2, ja_tinham: 0 });
  assert.deepEqual((await ana('POST', '/api/pesquisas/lote', {})).corpo, { criadas: 0, ja_tinham: 2 });

  // Excluir: link aguardando qualquer um; resposta só gestor/admin.
  assert.equal((await ana('DELETE', `/api/pesquisas/${id}`, {})).status, 403);
  assert.equal((await ana('DELETE', `/api/pesquisas/${exp.id}`, {})).status, 200);
  assert.equal((await chefe('DELETE', `/api/pesquisas/${id}`, {})).status, 200);

  const p = (await ana('GET', '/api/painel')).corpo;
  assert.equal(p.satisfacao.respostas, 1);
  assert.equal(p.satisfacao.aguardando, 2);
  assert.ok(p.alertas.some((a) => /detratores/.test(a.texto)));
  assert.equal((await chefe('GET', `/api/empresas/${outra}/dependencias`)).corpo.pesquisas, 2);
});
