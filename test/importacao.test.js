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
const { lerLinhas, analisarLinhas } = require('../src/importacao');

const fixture = (nome) => fs.readFileSync(path.join(__dirname, 'fixtures', nome));
const analisar = async (nome, conteudo, existentes = new Map()) => analisarLinhas(await lerLinhas(nome, conteudo ?? fixture(nome)), existentes);
const resumo = (r) => r.empresas.map((e) => [e.cnpj, e.razao_social, e.situacao]);

test('planilha .xlsx: cabeçalho fora da 1ª linha, CNPJ numérico sem zero à esquerda e plano', async () => {
  const r = await analisar('empresas.xlsx');
  assert.deepEqual(r.colunas_reconhecidas.slice(0, 2), ['CNPJ', 'Razão social']);
  const [padaria, zero, errado, cpf, repetida] = r.empresas;
  assert.equal(padaria.linha, 4);
  assert.deepEqual(
    [padaria.cnpj, padaria.razao_social, padaria.email, padaria.telefone, padaria.plano_notas, padaria.plano_nome, padaria.notas_incluidas, padaria.honorario_centavos],
    ['11222333000181', 'Padaria Pão Quente Ltda', 'contato@padaria.com.br', '(11) 98888-7777', true, 'Essencial', 10, 45000],
  );
  assert.equal(zero.cnpj, '04252011000110');
  assert.equal(zero.plano_notas, false);
  assert.equal(zero.telefone, null);
  assert.equal(zero.honorario_centavos, 120000);
  assert.match(errado.mensagem, /CNPJ inválido/);
  assert.match(cpf.mensagem, /CPF/);
  assert.match(repetida.mensagem, /repetido/);
  assert.equal(r.empresas.length, 5, 'linha de total é ignorada');
});

test('CSV do Excel (Windows-1252, ponto e vírgula, aspas)', async () => {
  const csv = Buffer.from('Razão Social;CNPJ;E-mail\r\n"Ótica ""Visão"" Ltda";11.444.777/0001-61;otica@x.com\r\n;;\r\n', 'latin1');
  const r = await analisar('clientes.csv', csv, new Map([['11444777000161', 'Ótica antiga']]));
  assert.deepEqual(resumo(r), [['11444777000161', 'Ótica "Visão" Ltda', 'existente']]);
  assert.match(r.empresas[0].mensagem, /Ótica antiga/);
});

test('PDF em tabela com títulos centralizados', async () => {
  const r = await analisar('relacao-clientes.pdf');
  assert.deepEqual(resumo(r), [
    ['11222333000181', 'Padaria Pão Quente Ltda', 'nova'],
    ['11444777000161', 'Clínica Bem Estar S/A', 'nova'],
    ['45723174000110', 'Mercadinho Central ME', 'nova'],
    ['12345678000100', 'Empresa Errada', 'erro'],
  ]);
  assert.equal(r.empresas[0].email, 'contato@padaria.com.br');
  assert.equal(r.empresas[1].telefone, '(21) 3333-4444');
});

test('PDF de sistema: fonte de largura fixa, nomes longos e cabeçalho repetido por página', async () => {
  const r = await analisar('relatorio-sistema.pdf');
  assert.deepEqual(resumo(r), [
    ['04252011000110', 'Comércio de Materiais de Construção Irmãos Albuquerque e Filhos Ltda', 'nova'],
    ['11222333000181', 'Padaria Pão Quente Ltda', 'nova'],
    ['11444777000161', 'Clínica Bem Estar S/A', 'nova'],
    ['45723174000110', 'Mercadinho Central ME', 'nova'],
  ]);
});

test('PDF em lista corrida, sem tabela', async () => {
  const r = await analisar('lista-clientes.pdf');
  assert.deepEqual(resumo(r), [
    ['11222333000181', 'Padaria Pão Quente Ltda', 'nova'],
    ['11444777000161', 'Clínica Bem Estar S/A', 'nova'],
  ]);
  assert.equal(r.empresas[0].email, 'contato@padaria.com.br');
});

test('formatos não suportados', async () => {
  await assert.rejects(lerLinhas('antiga.xls', Buffer.from('x')), /\.xls antigas/);
  await assert.rejects(lerLinhas('foto.png', Buffer.from('x')), /planilha/);
  await assert.rejects(lerLinhas('quebrado.pdf', Buffer.from('não é pdf')), /Não consegui abrir/);
});

test('API: analisar e importar, sem e com atualização das já cadastradas', async () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'notas-imp-'));
  const db = abrirBanco(':memory:');
  db.prepare("INSERT INTO usuarios (nome, email, senha_hash, papel) VALUES ('Admin', 'admin@x.com', ?, 'escritorio')").run(gerarHash('senha-admin'));
  db.prepare("INSERT INTO empresas (razao_social, cnpj, email, honorario_centavos) VALUES ('Padaria Antiga', '11222333000181', 'velho@padaria.com', 30000)").run();
  const servidor = http.createServer(criarApp({ db, pastaArquivos: pasta }));
  await new Promise((r) => servidor.listen(0, r));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  try {
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@x.com', senha: 'senha-admin' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const post = async (caminho, dados) => {
      const r = await fetch(`${base}${caminho}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(dados) });
      return { status: r.status, corpo: await r.json() };
    };

    let r = await post('/api/empresas/importar/analisar', { nome_arquivo: 'empresas.xlsx', conteudo_base64: fixture('empresas.xlsx').toString('base64') });
    assert.equal(r.status, 200);
    const empresas = r.corpo.empresas;
    assert.deepEqual(empresas.map((e) => e.situacao), ['existente', 'nova', 'erro', 'erro', 'erro']);

    const validas = empresas.filter((e) => e.situacao !== 'erro');
    r = await post('/api/empresas/importar', { empresas: validas });
    assert.deepEqual(r.corpo, { criadas: 1, atualizadas: 0, ignoradas: 1, erros: [] });

    r = await post('/api/empresas/importar', { empresas: validas, atualizar_existentes: true });
    assert.deepEqual(r.corpo, { criadas: 0, atualizadas: 2, ignoradas: 0, erros: [] });
    const padaria = db.prepare("SELECT * FROM empresas WHERE cnpj = '11222333000181'").get();
    assert.equal(padaria.razao_social, 'Padaria Pão Quente Ltda');
    assert.equal(padaria.email, 'contato@padaria.com.br');
    assert.equal(padaria.plano_notas, 1);
    assert.equal(padaria.notas_incluidas, 10);
    assert.equal(padaria.honorario_centavos, 45000);
    const zero = db.prepare("SELECT * FROM empresas WHERE cnpj = '04252011000110'").get();
    assert.equal(zero.razao_social, 'Zero à Esquerda Serviços ME');
    assert.equal(zero.honorario_centavos, 120000);

    // Linha com CNPJ inválido enviada à força: volta como erro, sem derrubar as demais.
    r = await post('/api/empresas/importar', { empresas: [{ cnpj: '12345678000100', razao_social: 'X' }, { cnpj: '11444777000161', razao_social: 'Nova SA' }] });
    assert.equal(r.corpo.criadas, 1);
    assert.match(r.corpo.erros[0].erro, /CNPJ inválido/);

    r = await post('/api/empresas/importar/analisar', { nome_arquivo: 'vazio.csv', conteudo_base64: Buffer.from('a;b\n1;2\n').toString('base64') });
    assert.equal(r.status, 422);

    const modelo = await fetch(`${base}/api/empresas/modelo.csv`, { headers: { Cookie: cookie } });
    assert.match(await modelo.text(), /CNPJ;Razão social/);
  } finally {
    servidor.close();
    fs.rmSync(pasta, { recursive: true, force: true });
  }
});
