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
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'notas-op-'));
  db = abrirBanco(':memory:');
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

// Insere solicitações direto no banco com a data de criação desejada (UTC).
function criarNotas(empresaId, criadoEm, quantidade, status = 'pendente') {
  const usuarioId = db.prepare('SELECT id FROM usuarios LIMIT 1').get().id;
  for (let i = 0; i < quantidade; i++) {
    db.prepare(`
      INSERT INTO solicitacoes (empresa_id, criado_por, tipo_nota, tomador_documento, tomador_nome, descricao,
        valor_centavos, data_competencia, status, criado_em)
      VALUES (?, ?, 'NFS-e', '52998224725', 'Tomador', 'Serviço', 10000, '2026-10-01', ?, ?)
    `).run(empresaId, usuarioId, status, criadoEm);
  }
}

test('plano na empresa, ocorrências e relatório do trimestre', async () => {
  const admin = await entrar('admin@x.com', 'senha-admin');

  // Empresa sem plano que pede muitas notas; empresa com plano que estoura a franquia; empresa tranquila.
  let r = await admin('POST', '/api/empresas', { razao_social: 'Sem Plano Ltda', cnpj: '11.222.333/0001-81', honorario: '450,00' });
  const semPlano = r.corpo.id;
  r = await admin('POST', '/api/empresas', {
    razao_social: 'Com Plano SA', cnpj: '11.444.777/0001-61', plano_notas: true, plano_nome: 'Essencial', notas_incluidas: 5,
  });
  const comPlano = r.corpo.id;
  r = await admin('POST', '/api/empresas', { razao_social: 'Tranquila ME', cnpj: '45.723.174/0001-10' });
  const tranquila = r.corpo.id;

  const empresas = (await admin('GET', '/api/empresas')).corpo;
  const cp = empresas.find((e) => e.id === comPlano);
  assert.equal(cp.plano_notas, 1);
  assert.equal(cp.notas_incluidas, 5);
  assert.equal(empresas.find((e) => e.id === semPlano).honorario_centavos, 45000);

  // Sem plano: 4 notas/mês em out, nov e dez (média 4).
  for (const mes of ['10', '11', '12']) criarNotas(semPlano, `2026-${mes}-10 15:00:00`, 4);
  // Com plano: 7 em outubro (acima de 5), 3 em novembro, 1 cancelada que não conta.
  criarNotas(comPlano, '2026-10-05 12:00:00', 7, 'emitida');
  criarNotas(comPlano, '2026-11-05 12:00:00', 3);
  criarNotas(comPlano, '2026-11-06 12:00:00', 1, 'cancelada');
  // 01/10 às 01h UTC ainda é 30/09 em Brasília: fica fora do período.
  criarNotas(tranquila, '2026-10-01 01:00:00', 1);
  // 01/01/2027 às 02h UTC ainda é 31/12/2026 em Brasília: entra em dezembro.
  criarNotas(tranquila, '2027-01-01 02:00:00', 1);

  // Ocorrências
  r = await admin('POST', '/api/ocorrencias', { empresa_id: semPlano, tipo: 'guia_recalculada', data: '2026-10-21', motivo: 'cliente_pagou_atrasado', causa: 'cliente' });
  assert.equal(r.status, 200);
  await admin('POST', '/api/ocorrencias', { empresa_id: semPlano, tipo: 'guia_recalculada', data: '2026-11-21', motivo: 'cliente_pagou_atrasado', causa: 'cliente' });
  await admin('POST', '/api/ocorrencias', { empresa_id: comPlano, tipo: 'multa', data: '2026-11-03', motivo: 'guia_apos_vencimento', causa: 'escritorio', valor: '150,75' });
  await admin('POST', '/api/ocorrencias', { empresa_id: comPlano, tipo: 'multa', data: '2026-12-10', motivo: 'falta_declaracao', causa: 'cliente', valor: '500,00' });
  // Fora do período: não entra no relatório.
  await admin('POST', '/api/ocorrencias', { empresa_id: tranquila, tipo: 'multa', data: '2027-01-15', motivo: 'outro', causa: 'outro', valor: '10,00' });

  // Validações
  r = await admin('POST', '/api/ocorrencias', { empresa_id: semPlano, tipo: 'multa', data: '2026-10-01', motivo: 'cliente_pagou_atrasado', causa: 'cliente' });
  assert.equal(r.status, 400, 'motivo de guia não vale para multa');
  r = await admin('POST', '/api/ocorrencias', { empresa_id: semPlano, tipo: 'multa', data: '2026-13-01', motivo: 'outro', causa: 'cliente' });
  assert.equal(r.status, 400);

  // Relatório com o período padrão (out a dez/2026)
  r = await admin('GET', '/api/relatorio');
  assert.equal(r.status, 200);
  const rel = r.corpo;
  assert.deepEqual(rel.meses, ['2026-10', '2026-11', '2026-12']);
  assert.equal(rel.totais.notas, 12 + 10 + 1);
  assert.equal(rel.totais.guias, 2);
  assert.equal(rel.totais.multas, 2);
  assert.equal(rel.totais.multas_valor_centavos, 65075);

  const sp = rel.empresas.find((e) => e.id === semPlano);
  assert.deepEqual(sp.notas.por_mes, { '2026-10': 4, '2026-11': 4, '2026-12': 4 });
  assert.equal(sp.notas.media_mensal, 4);
  assert.equal(sp.guias.cliente, 2);
  assert.ok(sp.sinais.some((s) => s.tipo === 'upsell' && /Sem plano/.test(s.texto)));
  assert.ok(sp.sinais.some((s) => s.tipo === 'cliente' && /2 guias/.test(s.texto)));

  const cpRel = rel.empresas.find((e) => e.id === comPlano);
  assert.deepEqual(cpRel.notas.por_mes, { '2026-10': 7, '2026-11': 3, '2026-12': 0 });
  assert.equal(cpRel.notas.emitidas, 7);
  assert.equal(cpRel.meses_acima_franquia, 1);
  assert.equal(cpRel.multas.valor_escritorio_centavos, 15075);
  assert.ok(cpRel.sinais.some((s) => s.tipo === 'upsell' && /franquia de 5 notas em 1 de 3/.test(s.texto)));
  assert.ok(cpRel.sinais.some((s) => s.tipo === 'qualidade'));

  const tr = rel.empresas.find((e) => e.id === tranquila);
  assert.deepEqual(tr.notas.por_mes, { '2026-10': 0, '2026-11': 0, '2026-12': 1 });
  assert.equal(tr.sinais.length, 0);
  assert.equal(tr.multas.total, 0);

  // Empresas com alerta vêm primeiro.
  assert.equal(rel.empresas.at(-1).id, tranquila);

  // CSV
  r = await admin('GET', '/api/relatorio.csv?inicio=2026-10-01&fim=2026-12-31');
  assert.equal(r.status, 200);
  const linhas = r.corpo.replace(/^﻿/, '').split('\r\n');
  assert.match(linhas[0], /Notas 10\/2026;Notas 11\/2026;Notas 12\/2026/);
  assert.match(r.corpo, /Com Plano SA;11444777000161;Sim;Essencial;5;;7;3;0;10;3,3;1;0;0;0;2;650,75;1;1;/);

  // Período inválido
  assert.equal((await admin('GET', '/api/relatorio?inicio=2026-12-01&fim=2026-10-01')).status, 400);

  // Filtro e exclusão de ocorrências
  r = await admin('GET', `/api/ocorrencias?empresa_id=${comPlano}&tipo=multa`);
  assert.equal(r.corpo.length, 2);
  assert.equal((await admin('DELETE', `/api/ocorrencias/${r.corpo[0].id}`, {})).status, 200);
  assert.equal((await admin('GET', `/api/ocorrencias?empresa_id=${comPlano}`)).corpo.length, 1);
});

test('clientes não acessam ocorrências nem relatório', async () => {
  const admin = await entrar('admin@x.com', 'senha-admin');
  const empresa = (await admin('GET', '/api/empresas')).corpo[0];
  await admin('POST', '/api/usuarios', { nome: 'Cliente', email: 'c@x.com', senha: 'senha-cliente', papel: 'cliente', empresa_id: empresa.id });
  const cliente = await entrar('c@x.com', 'senha-cliente');
  assert.equal((await cliente('GET', '/api/relatorio')).status, 403);
  assert.equal((await cliente('GET', '/api/ocorrencias')).status, 403);
  assert.equal((await cliente('POST', '/api/ocorrencias', { empresa_id: empresa.id })).status, 403);
});

test('banco antigo recebe as colunas de plano ao abrir', () => {
  const arquivo = path.join(pasta, 'antigo.db');
  const { DatabaseSync } = require('node:sqlite');
  const antigo = new DatabaseSync(arquivo);
  antigo.exec("CREATE TABLE empresas (id INTEGER PRIMARY KEY, razao_social TEXT NOT NULL, cnpj TEXT NOT NULL UNIQUE, email TEXT, telefone TEXT, ativo INTEGER NOT NULL DEFAULT 1, criado_em TEXT NOT NULL DEFAULT (datetime('now')))");
  antigo.exec("INSERT INTO empresas (razao_social, cnpj) VALUES ('Antiga', '11222333000181')");
  antigo.close();
  const migrado = abrirBanco(arquivo);
  const e = migrado.prepare('SELECT * FROM empresas').get();
  assert.equal(e.plano_notas, 0);
  assert.equal(e.notas_incluidas, null);
  migrado.close();
});
