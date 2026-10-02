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
const { mesesAte } = require('../src/painel');

let servidor;
let base;
let pasta;

test.before(async () => {
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'notas-painel-'));
  const db = abrirBanco(':memory:');
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

test('meses do gráfico atravessam a virada do ano', () => {
  assert.deepEqual(mesesAte('2027-02', 4), ['2026-11', '2026-12', '2027-01', '2027-02']);
});

test('cadastro de cliente com regime, CPF de autônomo, endereço e contrato', async () => {
  const api = await entrar('equipe@x.com', 'senha-equipe');

  const semDescricao = await api('POST', '/api/empresas', { razao_social: 'X', cnpj: '11222333000181', regime: 'outro' });
  assert.equal(semDescricao.status, 400);
  assert.match(semDescricao.corpo.erro, /Descrição do regime/);
  assert.equal((await api('POST', '/api/empresas', { razao_social: 'X', cnpj: '11222333000181', regime: 'xpto' })).status, 400);
  assert.equal((await api('POST', '/api/empresas', { razao_social: 'X', cnpj: '11222333000181', uf: 'ZZ' })).status, 400);
  assert.equal((await api('POST', '/api/empresas', { razao_social: 'X', cnpj: '11222333000181', data_contrato: '2026-13-40' })).status, 400);
  assert.equal((await api('POST', '/api/empresas', { razao_social: 'X', cnpj: '12345678901' })).status, 400);

  const criada = await api('POST', '/api/empresas', {
    razao_social: 'Comércio Ltda', nome_fantasia: 'Loja', cnpj: '11.222.333/0001-81', regime: 'simples_nacional',
    endereco: 'SCS Quadra 1', cidade: 'Brasília', uf: 'df', data_contrato: '2026-10-01', observacoes: 'Cliente desde a abertura',
    honorario: '800,00',
  });
  assert.equal(criada.status, 200);
  const autonomo = await api('POST', '/api/empresas', { razao_social: 'Fulano de Tal', cnpj: '529.982.247-25', regime: 'autonomo' });
  assert.equal(autonomo.status, 200);
  await api('POST', '/api/empresas', { razao_social: 'Outra', cnpj: '11444777000161', regime: 'outro', regime_outro: 'Imune', honorario: '400' });
  await api('POST', '/api/empresas', { razao_social: 'Sem regime', cnpj: '45723174000110', ativo: false, honorario: '999' });

  const lista = (await api('GET', '/api/empresas')).corpo;
  const e = lista.find((x) => x.id === criada.corpo.id);
  assert.equal(e.uf, 'DF');
  assert.equal(e.nome_fantasia, 'Loja');
  assert.equal(e.data_contrato, '2026-10-01');
  assert.equal(lista.find((x) => x.id === autonomo.corpo.id).cnpj, '52998224725');
  assert.equal(lista.find((x) => x.razao_social === 'Outra').regime_outro, 'Imune');

  // Edição sem regime "outro" descarta a descrição antiga.
  await api('PUT', `/api/empresas/${criada.corpo.id}`, { ...e, honorario: '800', regime: 'lucro_presumido', regime_outro: 'lixo' });
  const editada = (await api('GET', '/api/empresas')).corpo.find((x) => x.id === criada.corpo.id);
  assert.equal(editada.regime, 'lucro_presumido');
  assert.equal(editada.regime_outro, null);
  assert.equal(editada.observacoes, 'Cliente desde a abertura');

  const opcoes = (await api('GET', '/api/opcoes')).corpo;
  assert.equal(opcoes.regimes.simples_nacional, 'Simples Nacional');
});

test('dashboard soma clientes ativos, honorários, notas e multas do mês', async () => {
  const api = await entrar('equipe@x.com', 'senha-equipe');
  const empresas = (await api('GET', '/api/empresas')).corpo;
  const ativa = empresas.find((x) => x.razao_social === 'Comércio Ltda');
  await api('POST', '/api/notas-emitidas', { empresa_id: ativa.id, numero_nota: '10', data_emissao: '2026-10-05' });
  await api('POST', '/api/notas-emitidas', { empresa_id: ativa.id, numero_nota: '11', data_emissao: '2026-09-20' });
  await api('POST', '/api/ocorrencias', {
    empresa_id: ativa.id, tipo: 'multa', data: '2026-10-07', motivo: 'falta_declaracao', causa: 'escritorio', valor: '150,00',
  });

  const r = await api('GET', '/api/painel?mes=2026-10');
  assert.equal(r.status, 200);
  const p = r.corpo;
  assert.equal(p.clientes.ativos, 3);
  assert.equal(p.clientes.inativos, 1);
  assert.equal(p.clientes.novos_no_mes, 1);
  assert.equal(p.clientes.sem_honorario, 1); // o autônomo
  assert.equal(p.honorarios.base_mensal_centavos, 120000); // inativa fica de fora
  assert.equal(p.honorarios.ticket_medio_centavos, 60000);
  assert.deepEqual(p.clientes.por_regime.map((x) => [x.regime, x.quantidade]),
    [['lucro_presumido', 1], ['autonomo', 1], ['outro', 1]]);
  assert.equal(p.operacao.notas_emitidas, 1);
  assert.equal(p.operacao.multas, 1);
  assert.equal(p.operacao.multas_valor_centavos, 15000);
  assert.equal(p.operacao.multas_escritorio, 1);
  assert.deepEqual(p.meses, ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  assert.deepEqual(p.serie.map((s) => s.notas), [0, 0, 0, 0, 1, 1]);
  assert.ok(p.alertas.some((a) => /sem honorário/.test(a.texto)));

  assert.equal((await api('GET', '/api/painel?mes=2026-13')).status, 400);
});
