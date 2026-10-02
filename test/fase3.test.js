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
const mesAtual = dia(0).slice(0, 7);

test.before(async () => {
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'notas-fase3-'));
  db = abrirBanco(':memory:');
  const inserir = db.prepare('INSERT INTO usuarios (nome, email, senha_hash, papel, admin, gestor) VALUES (?, ?, ?, ?, ?, ?)');
  inserir.run('Chefe', 'chefe@x.com', gerarHash('senha-chefe'), 'escritorio', 1, 0);
  inserir.run('Gil', 'gil@x.com', gerarHash('senha-gil1'), 'escritorio', 0, 1);
  inserir.run('Ana', 'ana@x.com', gerarHash('senha-ana1'), 'escritorio', 0, 0);
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
    const texto = await resp.text();
    let corpo;
    try { corpo = JSON.parse(texto); } catch { corpo = texto; }
    return { status: resp.status, corpo };
  };
}

test('cadastro: dia de vencimento do honorário de 1 a 31', async () => {
  const chefe = await entrar('chefe@x.com', 'senha-chefe');
  assert.equal((await chefe('POST', '/api/empresas', { razao_social: 'X', cnpj: '11222333000181', dia_vencimento: 32 })).status, 400);
  const r = await chefe('POST', '/api/empresas', {
    razao_social: 'Padaria', cnpj: '11222333000181', honorario: '650', dia_vencimento: 31, regime: 'simples_nacional',
  });
  assert.equal(r.status, 200);
  await chefe('POST', '/api/empresas', { razao_social: 'Clínica', cnpj: '11444777000161', honorario: '1800', regime: 'lucro_presumido' });
  await chefe('POST', '/api/empresas', { razao_social: 'Sem honorário', cnpj: '45723174000110' });
  await chefe('POST', '/api/empresas', { razao_social: 'Inativa', cnpj: '04252011000110', honorario: '999', ativo: false });
  assert.equal((await chefe('GET', '/api/empresas')).corpo.find((e) => e.razao_social === 'Padaria').dia_vencimento, 31);
});

test('honorários: só gestor e administrador; geração do mês no dia de cada cliente', async () => {
  const gil = await entrar('gil@x.com', 'senha-gil1');
  const ana = await entrar('ana@x.com', 'senha-ana1');
  assert.equal((await ana('GET', '/api/honorarios')).status, 403);
  assert.equal((await ana('GET', '/api/receita')).status, 403);
  assert.equal((await ana('POST', '/api/honorarios/gerar', { competencia: '2026-02', dia_padrao: 10 })).status, 403);

  const pedido = { competencia: '2026-02', dia_padrao: 10 };
  assert.equal((await gil('POST', '/api/honorarios/gerar', { ...pedido, dia_padrao: 0 })).status, 400);
  assert.equal((await gil('POST', '/api/honorarios/gerar', { ...pedido, tipo: 'extra' })).status, 400);
  const previa = (await gil('POST', '/api/honorarios/gerar/previa', pedido)).corpo;
  assert.equal(previa.novos, 2);
  assert.equal(previa.valor_centavos, 245000);
  assert.equal(previa.sem_honorario, 1);
  // Dia 31 em fevereiro vira o último dia do mês; sem dia no cadastro, vale o padrão.
  assert.deepEqual(previa.empresas.map((e) => [e.razao_social, e.vencimento]), [['Clínica', '2026-02-10'], ['Padaria', '2026-02-28']]);
  assert.deepEqual((await gil('POST', '/api/honorarios/gerar', pedido)).corpo, { criados: 2, ignorados: 0 });
  assert.deepEqual((await gil('POST', '/api/honorarios/gerar', pedido)).corpo, { criados: 0, ignorados: 2 });

  const { lista, resumo } = (await gil('GET', '/api/honorarios?competencia=2026-02')).corpo;
  assert.equal(lista.length, 2);
  assert.ok(lista.every((h) => h.situacao === 'atrasado')); // fevereiro já passou
  assert.equal(resumo.atrasado.valor_centavos, 245000);
});

test('honorários: cobrança avulsa, duplicidade, recebimento, cancelamento e CSV', async () => {
  const gil = await entrar('gil@x.com', 'senha-gil1');
  const empresas = (await gil('GET', '/api/empresas')).corpo;
  const padaria = empresas.find((e) => e.razao_social === 'Padaria').id;
  const clinica = empresas.find((e) => e.razao_social === 'Clínica').id;

  const mensal = { empresa_id: padaria, tipo: 'mensal', competencia: '2026-02', vencimento: '2026-02-20', valor: '650' };
  assert.equal((await gil('POST', '/api/honorarios', mensal)).status, 409);
  assert.match((await gil('POST', '/api/honorarios', { ...mensal, tipo: 'extra' })).corpo.erro, /Descrição/);
  assert.equal((await gil('POST', '/api/honorarios', { ...mensal, competencia: mesAtual, valor: '0' })).status, 400);

  const extra = (await gil('POST', '/api/honorarios', {
    empresa_id: clinica, tipo: 'extra', descricao: 'Declaração de IRPF do sócio', competencia: mesAtual, vencimento: dia(5), valor: '350,00',
  })).corpo.id;
  const doMes = (await gil('POST', '/api/honorarios', { ...mensal, competencia: mesAtual, vencimento: dia(3) })).corpo.id;

  assert.match((await gil('POST', `/api/honorarios/${extra}/acao`, { acao: 'receber', forma_pagamento: 'outro' })).corpo.erro, /forma de pagamento/);
  assert.equal((await gil('POST', `/api/honorarios/${extra}/acao`, { acao: 'receber', forma_pagamento: 'pix', valor: '340', data: dia(0) })).status, 200);
  assert.equal((await gil('POST', `/api/honorarios/${extra}/acao`, { acao: 'receber' })).status, 400);
  assert.equal((await gil('POST', `/api/honorarios/${doMes}/acao`, { acao: 'cancelar' })).status, 200);
  // Com a do mês cancelada, pode lançar outra mensal na mesma competência; reabrir a cancelada passa a conflitar.
  const substituta = (await gil('POST', '/api/honorarios', { ...mensal, competencia: mesAtual, vencimento: dia(4), valor: '700' })).corpo.id;
  assert.ok(substituta);
  assert.equal((await gil('POST', `/api/honorarios/${doMes}/acao`, { acao: 'reabrir' })).status, 409);

  const r = (await gil('GET', `/api/honorarios?competencia=${mesAtual}`)).corpo;
  assert.equal(r.resumo.recebido.valor_centavos, 34000);
  assert.equal(r.resumo.cancelado.quantidade, 1);
  assert.equal(r.resumo.aberto.valor_centavos, 70000);
  assert.equal((await gil('GET', '/api/honorarios?situacao=atrasado')).corpo.lista.length, 2);

  const csv = await gil('GET', `/api/honorarios.csv?competencia=${mesAtual}`);
  assert.match(csv.corpo, /Declaração de IRPF do sócio;.*340,00;Pix/);

  // Excluir: gestor pode.
  assert.equal((await gil('DELETE', `/api/honorarios/${doMes}`, {})).status, 200);
});

test('receita: recorrente, faturado, recebido, atrasos e dashboard do gestor', async () => {
  const gil = await entrar('gil@x.com', 'senha-gil1');
  const ana = await entrar('ana@x.com', 'senha-ana1');
  const rec = (await gil('GET', `/api/receita?mes=${mesAtual}`)).corpo;
  assert.equal(rec.recorrente_centavos, 245000);
  assert.equal(rec.clientes_com_honorario, 2);
  assert.equal(rec.faturado_centavos, 105000); // extra 350 + mensal 700
  assert.equal(rec.recebido_centavos, 34000);
  assert.equal(rec.atrasado.valor_centavos, 245000);
  assert.equal(rec.atrasado.clientes, 2);
  assert.equal(rec.por_tipo.extra, 35000);
  assert.equal(rec.serie.length, 6);
  assert.equal(rec.serie.at(-1).recebido_centavos, 34000);
  const padaria = rec.clientes.find((c) => c.razao_social === 'Padaria');
  assert.equal(padaria.em_aberto_centavos, 70000);
  assert.equal(padaria.atrasado_desde, '2026-02-28');
  assert.ok(!rec.clientes.some((c) => c.razao_social === 'Sem honorário'));

  const pGestor = (await gil('GET', `/api/painel?mes=${mesAtual}`)).corpo;
  assert.equal(pGestor.financeiro.atrasado_cobrancas, 2);
  assert.ok(pGestor.alertas.some((a) => /honorário em atraso/.test(a.texto)));
  assert.equal((await ana('GET', `/api/painel?mes=${mesAtual}`)).corpo.financeiro, null);

  const chefe = await entrar('chefe@x.com', 'senha-chefe');
  const idPadaria = padaria.id;
  assert.equal((await chefe('GET', `/api/empresas/${idPadaria}/dependencias`)).corpo.honorarios, 2);
  assert.equal((await chefe('DELETE', `/api/empresas/${idPadaria}`, { confirmacao: 'EXCLUIR' })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM honorarios WHERE empresa_id = ?').get(idPadaria).n, 0);
});
