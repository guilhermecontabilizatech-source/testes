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
const { lerAtributos, normalizarNome } = require('../src/zen');

const TOKEN = 'token-do-webhook-de-teste';
const PDF = Buffer.from('%PDF-1.4 guia de teste');

let servidor;
let base;
let pasta;
let db;

test.before(async () => {
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'notas-zen-'));
  db = abrirBanco(':memory:');
  db.prepare("INSERT INTO usuarios (nome, email, senha_hash, papel, admin) VALUES ('Chefe', 'chefe@x.com', ?, 'escritorio', 1)").run(gerarHash('senha-chefe'));
  servidor = http.createServer(criarApp({ db, pastaArquivos: pasta, portalClientes: true, zenWebhookToken: TOKEN }));
  await new Promise((r) => servidor.listen(0, r));
  base = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(() => {
  servidor.close();
  fs.rmSync(pasta, { recursive: true, force: true });
});

async function entrar(email, senha) {
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, senha }) });
  assert.equal(r.status, 200, `login de ${email}`);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return async (metodo, caminho, dados) => {
    const resp = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers: { Cookie: cookie, ...(dados ? { 'Content-Type': 'application/json' } : {}) },
      body: dados ? JSON.stringify(dados) : undefined,
    });
    const tipo = resp.headers.get('content-type') ?? '';
    return { status: resp.status, corpo: tipo.includes('json') ? await resp.json() : Buffer.from(await resp.arrayBuffer()) };
  };
}

const webhook = (corpo, cabecalhos = {}) => fetch(`${base}/api/zen/webhook`, {
  method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, ...cabecalhos }, body: corpo,
});

// Exemplo da documentação do Zen, com o arquivo em base64 e o cliente nos destinatários.
const exemplo = (extra = {}) => ({
  Id: 'ABC123',
  Titulo: 'DARF Simples Nacional',
  EhPagavel: true,
  CategoriaId: '61437bdf4f284c0b4020391c',
  CategoriaDescricao: 'Guias Federais',
  DataCriacao: '2026-10-05T15:13:56.6370258-03:00',
  Observacao: 'Vence dia 20',
  Arquivo: PDF.toString('base64'),
  Chave: '294',
  Status: 'Opened',
  Atributos: [
    { Nome: 'DatePublication', Valor: '05/10/2026 15:13:56' },
    { Nome: 'DateExpire', Valor: '20/10/2026 00:00:00' },
    { Nome: 'Value', Valor: '1.234,56' },
    { Nome: 'MonthCompetence', Valor: '09' },
    { Nome: 'YearCompetence', Valor: '2026' },
  ],
  Destinatarios: [{ ClienteNome: 'PADARIA BOA LTDA - ME', Usuarios: [{ UsuarioNome: 'Dono', UsuarioEmail: 'dono@padaria.com' }] }],
  ...extra,
});

test('leitura de atributos e nomes', () => {
  assert.deepEqual(lerAtributos(exemplo().Atributos), { vencimento: '2026-10-20', competencia: '2026-09', valor_centavos: 123456 });
  assert.deepEqual(lerAtributos({ DataVencimento: '2022-12-12', DataCompetencia: '202201', Valor: '1200.00' }),
    { vencimento: '2022-12-12', competencia: '2022-01', valor_centavos: 120000 });
  assert.equal(normalizarNome('Padaria Boa Ltda.'), normalizarNome('PADARIA BOA LTDA - ME'));
  assert.equal(normalizarNome('Comércio São José S/A'), 'COMERCIO SAO JOSE');
});

test('webhook: autenticação, recebimento, associação e portal do cliente', async () => {
  const chefe = await entrar('chefe@x.com', 'senha-chefe');
  const padaria = (await chefe('POST', '/api/empresas', { razao_social: 'Padaria Boa Ltda.', cnpj: '11222333000181' })).corpo.id;
  const outra = (await chefe('POST', '/api/empresas', { razao_social: 'Outra Empresa', cnpj: '11444777000161' })).corpo.id;

  assert.equal((await webhook(JSON.stringify(exemplo()), { Authorization: 'Bearer errado' })).status, 401);
  assert.equal((await webhook(JSON.stringify(exemplo()), { Authorization: '' })).status, 401);

  // Enviado como o curl da documentação (sem Content-Type JSON).
  let r = await webhook(JSON.stringify(exemplo()), { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(r.status, 200);
  const [id] = (await r.json()).documentos;

  let doc = (await chefe('GET', `/api/zen/documentos/${id}`)).corpo;
  assert.equal(doc.empresa_id, padaria);
  assert.equal(doc.associacao, 'nome');
  assert.equal(doc.vencimento, '2026-10-20');
  assert.equal(doc.competencia, '2026-09');
  assert.equal(doc.valor_centavos, 123456);
  assert.equal(doc.tipo_mime, 'application/pdf');
  assert.equal(doc.nome_arquivo, 'DARF Simples Nacional.pdf');
  assert.equal(doc.destinatarios_emails, 'dono@padaria.com');
  assert.match(doc.payload, /caracteres omitidos|DARF/);

  // Reenvio do mesmo documento atualiza em vez de duplicar.
  r = await webhook(JSON.stringify(exemplo({ Titulo: 'DARF corrigido' })), { 'Content-Type': 'application/json' });
  assert.deepEqual((await r.json()).documentos, [id]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM zen_documentos').get().n, 1);
  assert.equal(fs.readdirSync(pasta).length, 1, 'arquivo anterior substituído');

  // Multipart com o arquivo como anexo e cliente desconhecido: fica sem empresa.
  const form = new FormData();
  form.append('Id', 'XYZ9');
  form.append('Titulo', 'Contrato');
  form.append('Destinatarios', JSON.stringify([{ ClienteNome: 'Cliente Novo Ltda' }]));
  form.append('Arquivo', new Blob([PDF], { type: 'application/pdf' }), 'contrato.pdf');
  r = await webhook(form);
  assert.equal(r.status, 200);
  const [idSem] = (await r.json()).documentos;
  doc = (await chefe('GET', `/api/zen/documentos/${idSem}`)).corpo;
  assert.equal(doc.empresa_id, null);
  assert.equal(doc.cliente_nome, 'Cliente Novo Ltda');
  assert.equal(doc.nome_arquivo, 'contrato.pdf');
  assert.equal((await chefe('GET', '/api/zen/status')).corpo.sem_empresa, 1);

  // Associação manual vale para os próximos documentos do mesmo cliente.
  await chefe('PUT', `/api/zen/documentos/${idSem}/empresa`, { empresa_id: outra });
  r = await webhook(JSON.stringify({ Id: 'XYZ10', Titulo: 'Outro', Arquivo: '', Destinatarios: [{ ClienteNome: 'Cliente Novo Ltda' }] }));
  const [idProx] = (await r.json()).documentos;
  doc = (await chefe('GET', `/api/zen/documentos/${idProx}`)).corpo;
  assert.equal(doc.empresa_id, outra);
  assert.equal(doc.associacao, 'anterior');
  assert.match(doc.arquivo_info, /vazio/);

  // Conteúdo irreconhecível também fica guardado para conferência.
  r = await webhook('isto não é json', { 'Content-Type': 'text/plain' });
  assert.equal(r.status, 200);

  // Portal: cliente vê só os documentos da própria empresa e não acessa o resto do sistema.
  assert.equal((await chefe('POST', '/api/usuarios', { nome: 'Dono', email: 'dono@padaria.com', senha: 'senha-dono1', papel: 'cliente', empresa_id: padaria })).status, 200);
  const cliente = await entrar('dono@padaria.com', 'senha-dono1');
  const lista = (await cliente('GET', '/api/portal/documentos')).corpo;
  assert.deepEqual(lista.map((d) => d.titulo), ['DARF corrigido']);
  r = await cliente('GET', `/api/zen/documentos/${id}/arquivo`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.corpo, PDF);
  assert.equal((await cliente('GET', `/api/zen/documentos/${idSem}/arquivo`)).status, 404, 'documento de outra empresa');
  assert.equal((await cliente('GET', '/api/zen/documentos')).status, 403);
  assert.equal((await cliente('GET', '/api/solicitacoes')).status, 403);
  assert.equal((await cliente('GET', '/api/me')).status, 200);
});

test('simulação de recebimento pelo administrador', async () => {
  const chefe = await entrar('chefe@x.com', 'senha-chefe');
  const empresa = db.prepare('SELECT id FROM empresas ORDER BY id LIMIT 1').get().id;
  const r = await chefe('POST', '/api/zen/teste', { empresa_id: empresa });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.empresa_id, empresa);
  const doc = (await chefe('GET', `/api/zen/documentos/${r.corpo.id}`)).corpo;
  assert.equal(doc.tipo_mime, 'application/pdf');
  assert.equal(doc.valor_centavos, 12345);
});

test('webhook desligado sem token configurado', async () => {
  const outro = http.createServer(criarApp({ db: abrirBanco(':memory:'), pastaArquivos: pasta }));
  await new Promise((r) => outro.listen(0, r));
  const r = await fetch(`http://127.0.0.1:${outro.address().port}/api/zen/webhook`, { method: 'POST', body: '{}' });
  assert.equal(r.status, 503);
  outro.close();
});
