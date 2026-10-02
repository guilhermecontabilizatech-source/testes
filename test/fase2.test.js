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

// Datas relativas a hoje (horário de Brasília), para "vencido" e "atrasada" não dependerem do dia do teste.
const dia = (deslocamento) => new Date(Date.now() - 3 * 3600000 + deslocamento * 86400000).toISOString().slice(0, 10);

test.before(async () => {
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'notas-fase2-'));
  db = abrirBanco(':memory:');
  const inserir = db.prepare('INSERT INTO usuarios (nome, email, senha_hash, papel, admin) VALUES (?, ?, ?, ?, ?)');
  inserir.run('Chefe', 'chefe@x.com', gerarHash('senha-chefe'), 'escritorio', 1);
  inserir.run('Ana', 'ana@x.com', gerarHash('senha-ana1'), 'escritorio', 0);
  inserir.run('Bia', 'bia@x.com', gerarHash('senha-bia1'), 'escritorio', 0);
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

const id = (email) => db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email).id;

test('perfil de gestor: só administrador concede; administrador não acumula gestor', async () => {
  const chefe = await entrar('chefe@x.com', 'senha-chefe');
  const ana = await entrar('ana@x.com', 'senha-ana1');

  assert.equal((await ana('PUT', `/api/usuarios/${id('bia@x.com')}`, { nome: 'Bia', ativo: true, perfil: 'gestor' })).status, 403);
  assert.equal((await chefe('PUT', `/api/usuarios/${id('bia@x.com')}`, { nome: 'Bia', ativo: true, perfil: 'xpto' })).status, 400);
  assert.equal((await chefe('PUT', `/api/usuarios/${id('bia@x.com')}`, { nome: 'Bia', ativo: true, perfil: 'gestor' })).status, 200);
  assert.equal((await chefe('GET', '/api/usuarios')).corpo.find((u) => u.email === 'bia@x.com').gestor, 1);

  // Criado por colaborador: nasce colaborador, mesmo pedindo gestor.
  await ana('POST', '/api/usuarios', { nome: 'Caio', email: 'caio@x.com', senha: 'senha-caio1', perfil: 'gestor' });
  assert.equal(db.prepare("SELECT gestor FROM usuarios WHERE email = 'caio@x.com'").get().gestor, 0);
  await chefe('POST', '/api/usuarios', { nome: 'Duda', email: 'duda@x.com', senha: 'senha-duda1', perfil: 'admin' });
  assert.deepEqual({ ...db.prepare("SELECT admin, gestor FROM usuarios WHERE email = 'duda@x.com'").get() }, { admin: 1, gestor: 0 });
  assert.equal((await (await entrar('bia@x.com', 'senha-bia1'))('GET', '/api/me')).corpo.gestor, 1);
});

test('demandas: criação, permissões por perfil, status, comentários e exclusão', async () => {
  const chefe = await entrar('chefe@x.com', 'senha-chefe');
  const ana = await entrar('ana@x.com', 'senha-ana1');
  const bia = await entrar('bia@x.com', 'senha-bia1'); // gestora
  const caio = await entrar('caio@x.com', 'senha-caio1'); // colaborador
  const empresa = (await chefe('POST', '/api/empresas', { razao_social: 'Cliente Demandas', cnpj: '11222333000181', regime: 'simples_nacional' })).corpo.id;

  assert.match((await ana('POST', '/api/demandas', { empresa_id: empresa, tipo: 'certidao' })).corpo.erro, /Título/);
  assert.match((await ana('POST', '/api/demandas', { empresa_id: empresa, titulo: 'X', tipo: 'outro' })).corpo.erro, /Descrição do tipo/);
  assert.equal((await ana('POST', '/api/demandas', { empresa_id: empresa, titulo: 'X', tipo: 'certidao', prazo: '2026-02-31' })).status, 400);

  const atrasada = (await ana('POST', '/api/demandas', {
    empresa_id: empresa, titulo: 'CND federal', tipo: 'certidao', prioridade: 'urgente', prazo: dia(-2), responsavel_id: id('ana@x.com'),
  })).corpo.id;
  const semDono = (await chefe('POST', '/api/demandas', { empresa_id: empresa, titulo: 'Dúvida sobre pró-labore', tipo: 'atendimento' })).corpo.id;

  // Caio (colaborador) não mexe na demanda da Ana; a gestora Bia mexe.
  const detalhe = (await caio('GET', `/api/demandas/${atrasada}`)).corpo;
  assert.equal(detalhe.pode_alterar, false);
  assert.equal(detalhe.atrasada, true);
  assert.equal((await caio('POST', `/api/demandas/${atrasada}/status`, { status: 'em_andamento' })).status, 403);
  assert.equal((await bia('POST', `/api/demandas/${atrasada}/status`, { status: 'em_andamento' })).status, 200);
  // Demanda sem responsável: qualquer um assume.
  assert.equal((await caio('PUT', `/api/demandas/${semDono}`, {
    empresa_id: empresa, titulo: 'Dúvida sobre pró-labore', tipo: 'atendimento', responsavel_id: id('caio@x.com'), prazo: dia(3),
  })).status, 200);

  // Comentário é livre para a equipe; cancelar exige motivo.
  assert.equal((await caio('POST', `/api/demandas/${atrasada}/comentarios`, { mensagem: 'Cliente mandou o documento' })).status, 200);
  assert.equal((await ana('POST', `/api/demandas/${atrasada}/status`, { status: 'cancelada' })).status, 400);
  assert.equal((await ana('POST', `/api/demandas/${atrasada}/status`, { status: 'concluida' })).status, 200);

  const d = (await ana('GET', `/api/demandas/${atrasada}`)).corpo;
  assert.equal(d.concluida_em, dia(0));
  assert.equal(d.atrasada, false);
  assert.deepEqual(d.historico.map((h) => h.acao), ['criada', 'status:em_andamento', 'comentario', 'status:concluida']);
  const editada = (await caio('GET', `/api/demandas/${semDono}`)).corpo.historico.find((h) => h.acao === 'editada');
  assert.match(editada.mensagem, /Responsável: Caio/);

  // Listas: abertas por padrão, "minhas" e resumo por status.
  let r = (await caio('GET', '/api/demandas')).corpo;
  assert.deepEqual(r.lista.map((x) => x.id), [semDono]);
  assert.equal(r.resumo.concluida, 1);
  assert.equal((await ana('GET', '/api/demandas?responsavel_id=eu')).corpo.lista.length, 0);
  assert.equal((await caio('GET', '/api/demandas?responsavel_id=eu&status=todas')).corpo.lista.length, 1);
  assert.equal((await ana('GET', '/api/demandas?busca=CND&status=todas')).corpo.lista.length, 1);
  assert.equal((await ana('GET', '/api/demandas?status=xpto')).status, 400);

  // Excluir: só gestor ou administrador.
  assert.equal((await caio('DELETE', `/api/demandas/${semDono}`, {})).status, 403);
  assert.equal((await bia('DELETE', `/api/demandas/${semDono}`, {})).status, 200);
  r = (await chefe('GET', '/api/demandas?status=todas')).corpo;
  assert.equal(r.lista.length, 1);
});

test('vencimentos: cadastro, envio, pagamento, situação e geração em lote', async () => {
  const chefe = await entrar('chefe@x.com', 'senha-chefe');
  const ana = await entrar('ana@x.com', 'senha-ana1');
  const empresas = (await chefe('GET', '/api/empresas')).corpo;
  const simples = empresas[0].id;
  const mei = (await chefe('POST', '/api/empresas', { razao_social: 'MEI Fulano', cnpj: '11444777000161', regime: 'mei' })).corpo.id;
  await chefe('POST', '/api/empresas', { razao_social: 'Inativa', cnpj: '45723174000110', regime: 'simples_nacional', ativo: false });

  assert.match((await ana('POST', '/api/vencimentos', { empresa_id: simples, tributo: 'das' })).corpo.erro, /vencimento/);
  assert.match((await ana('POST', '/api/vencimentos', { empresa_id: simples, tributo: 'outro', vencimento: dia(1) })).corpo.erro, /Descrição do tributo/);
  assert.equal((await ana('POST', '/api/vencimentos', { empresa_id: simples, tributo: 'das', vencimento: dia(1), competencia: '2026-13' })).status, 400);

  const vencido = (await ana('POST', '/api/vencimentos', {
    empresa_id: simples, tributo: 'fgts', vencimento: dia(-1), valor: '320,50', competencia: '2026-09',
  })).corpo.id;
  const aVencer = (await ana('POST', '/api/vencimentos', { empresa_id: mei, tributo: 'das_mei', vencimento: dia(2), valor: '81,05' })).corpo.id;

  const mes = dia(-1).slice(0, 7);
  let r = (await ana('GET', '/api/vencimentos?situacao=vencido')).corpo;
  assert.deepEqual(r.lista.map((v) => v.id), [vencido]);
  assert.equal(r.resumo.vencido.valor_centavos, 32050);

  assert.equal((await ana('POST', `/api/vencimentos/${aVencer}/acao`, { acao: 'enviar' })).status, 200);
  assert.equal((await ana('POST', `/api/vencimentos/${vencido}/acao`, { acao: 'pagar', valor: '335,00', data: dia(0) })).status, 200);
  assert.equal((await ana('POST', `/api/vencimentos/${vencido}/acao`, { acao: 'pagar' })).status, 400);
  assert.equal((await ana('POST', `/api/vencimentos/${vencido}/acao`, { acao: 'xpto' })).status, 400);

  r = (await ana('GET', '/api/vencimentos?mes=')).corpo;
  const pago = r.lista.find((v) => v.id === vencido);
  assert.equal(pago.situacao, 'pago');
  assert.equal(pago.valor_pago_centavos, 33500);
  assert.equal(r.lista.find((v) => v.id === aVencer).enviada_em, dia(0));
  assert.equal(r.resumo.vencido.quantidade, 0);
  assert.equal((await ana('GET', `/api/vencimentos?mes=${mes}&empresa_id=${mei}`)).corpo.lista.every((v) => v.empresa_id === mei), true);

  // Reabrir volta para pendente e limpa o pagamento.
  await ana('POST', `/api/vencimentos/${vencido}/acao`, { acao: 'reabrir' });
  assert.equal((await ana('GET', '/api/vencimentos?situacao=vencido')).corpo.lista[0].valor_pago_centavos, null);

  // Geração: DAS da competência para Simples e MEI ativos; não duplica.
  const pedido = { tributo: 'das', competencia: '2026-10', vencimento: '2026-11-20', regimes: ['simples_nacional', 'mei'] };
  assert.equal((await ana('POST', '/api/vencimentos/gerar', { ...pedido, regimes: [] })).status, 400);
  const previa = (await ana('POST', '/api/vencimentos/gerar/previa', pedido)).corpo;
  assert.equal(previa.novos, 2);
  assert.deepEqual(await ana('POST', '/api/vencimentos/gerar', pedido).then((x) => x.corpo), { criados: 2, ignorados: 0 });
  assert.deepEqual(await ana('POST', '/api/vencimentos/gerar', pedido).then((x) => x.corpo), { criados: 0, ignorados: 2 });
  assert.equal((await ana('GET', '/api/vencimentos?mes=2026-11')).corpo.lista.length, 2);

  // Excluir: só gestor ou administrador.
  assert.equal((await ana('DELETE', `/api/vencimentos/${aVencer}`, {})).status, 403);
  assert.equal((await chefe('DELETE', `/api/vencimentos/${aVencer}`, {})).status, 200);
});

test('dashboard traz demandas e vencimentos; excluir cliente leva tudo junto', async () => {
  const chefe = await entrar('chefe@x.com', 'senha-chefe');
  const ana = await entrar('ana@x.com', 'senha-ana1');
  const empresa = (await chefe('GET', '/api/empresas')).corpo.find((e) => e.razao_social === 'MEI Fulano').id;
  await ana('POST', '/api/demandas', { empresa_id: empresa, titulo: 'Atrasada', tipo: 'declaracao', prazo: dia(-1), responsavel_id: id('ana@x.com') });
  await ana('POST', '/api/vencimentos', { empresa_id: empresa, tributo: 'iss', vencimento: dia(3) });

  const p = (await ana('GET', `/api/painel?mes=${dia(0).slice(0, 7)}`)).corpo;
  assert.equal(p.demandas.atrasadas, 1);
  assert.equal(p.demandas.minhas, 1);
  assert.equal(p.vencimentos.vencidos, 1); // o FGTS reaberto
  assert.equal(p.vencimentos.proximos_sem_envio, 1);
  assert.ok(p.alertas.some((a) => /demanda\(s\) com prazo vencido/.test(a.texto)));
  assert.ok(p.alertas.some((a) => /não enviada/.test(a.texto)));

  const dep = (await chefe('GET', `/api/empresas/${empresa}/dependencias`)).corpo;
  assert.equal(dep.demandas, 1);
  assert.equal(dep.vencimentos, 2);
  assert.equal((await chefe('DELETE', `/api/empresas/${empresa}`, {})).status, 409);
  assert.equal((await chefe('DELETE', `/api/empresas/${empresa}`, { confirmacao: 'EXCLUIR' })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vencimentos WHERE empresa_id = ?').get(empresa).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM demandas WHERE empresa_id = ?').get(empresa).n, 0);
});
