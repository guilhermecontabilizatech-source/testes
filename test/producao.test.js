'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { abrirBanco } = require('../src/db');
const { criarApp } = require('../src/app');
const { gerarHash } = require('../src/auth');
const { criarLimitador } = require('../src/limitador');
const { fazerBackup, msAte } = require('../src/backup');

test('limitador bloqueia após 5 falhas da mesma conta e libera após a janela', () => {
  let agora = 0;
  const lim = criarLimitador({ agora: () => agora });
  for (let i = 0; i < 5; i++) {
    assert.equal(lim.bloqueio('1.1.1.1', 'a@x.com'), 0);
    lim.falhou('1.1.1.1', 'a@x.com');
  }
  assert.equal(lim.bloqueio('1.1.1.1', 'A@X.com'), 15);
  assert.equal(lim.bloqueio('1.1.1.1', 'b@x.com'), 0, 'outra conta segue liberada');
  assert.equal(lim.bloqueio('2.2.2.2', 'a@x.com'), 0, 'outro IP segue liberado');
  agora = 15 * 60 * 1000 + 1;
  assert.equal(lim.bloqueio('1.1.1.1', 'a@x.com'), 0);
});

test('limitador bloqueia IP com muitas falhas em contas diferentes', () => {
  const lim = criarLimitador({ maxPorIp: 3 });
  for (const e of ['a', 'b', 'c']) lim.falhou('9.9.9.9', `${e}@x.com`);
  assert.ok(lim.bloqueio('9.9.9.9', 'd@x.com') > 0);
});

test('msAte calcula o próximo horário de Brasília', () => {
  const agora = Date.parse('2026-10-01T05:00:00Z'); // 02:00 em Brasília
  assert.equal(msAte(3, agora), 60 * 60 * 1000);
  assert.equal(msAte(2, agora), 24 * 60 * 60 * 1000);
  const noite = Date.parse('2026-10-01T00:30:00Z'); // 21:30 do dia 30/09 em Brasília
  assert.equal(msAte(22, noite), 30 * 60 * 1000);
});

test('login: 429 após tentativas erradas, saúde responde sem login', async () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'notas-prod-'));
  const db = abrirBanco(':memory:');
  db.prepare("INSERT INTO usuarios (nome, email, senha_hash, papel) VALUES ('Admin', 'admin@x.com', ?, 'escritorio')")
    .run(gerarHash('senha-certa'));
  const servidor = http.createServer(criarApp({ db, pastaArquivos: pasta, confiarProxy: true }));
  await new Promise((r) => servidor.listen(0, r));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const login = (senha, ip) => fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `6.6.6.6, ${ip}` },
    body: JSON.stringify({ email: 'admin@x.com', senha }),
  });
  try {
    assert.deepEqual(await (await fetch(`${base}/api/saude`)).json(), { ok: true });
    for (let i = 0; i < 5; i++) assert.equal((await login('errada', '10.0.0.1')).status, 401);
    const bloqueado = await login('senha-certa', '10.0.0.1');
    assert.equal(bloqueado.status, 429);
    assert.match((await bloqueado.json()).erro, /Muitas tentativas/);
    // Outro IP (o último do X-Forwarded-For) não é afetado; o primeiro valor é ignorado.
    assert.equal((await login('senha-certa', '10.0.0.2')).status, 200);
  } finally {
    servidor.close();
    fs.rmSync(pasta, { recursive: true, force: true });
  }
});

test('backup copia banco e anexos e remove cópias antigas', async () => {
  const pastaDados = fs.mkdtempSync(path.join(os.tmpdir(), 'notas-bkp-'));
  const pastaBackup = path.join(pastaDados, 'backups');
  try {
    const db = abrirBanco(path.join(pastaDados, 'notas.db'));
    db.prepare("INSERT INTO empresas (razao_social, cnpj) VALUES ('Backup Ltda', '11222333000181')").run();
    fs.mkdirSync(path.join(pastaDados, 'anexos'));
    fs.writeFileSync(path.join(pastaDados, 'anexos', 'a.pdf'), '%PDF');

    fs.mkdirSync(pastaBackup);
    const antigo = path.join(pastaBackup, 'notas-2020-01-01-03-00.db');
    fs.writeFileSync(antigo, 'x');
    fs.utimesSync(antigo, new Date('2020-01-01'), new Date('2020-01-01'));

    const r = await fazerBackup({ db, pastaDados, pastaBackup, manterDias: 30 });
    assert.equal(r.anexosCopiados, 1);
    assert.equal(r.removidos, 1);
    assert.ok(!fs.existsSync(antigo));
    const copia = new DatabaseSync(r.destino);
    assert.equal(copia.prepare('SELECT razao_social FROM empresas').get().razao_social, 'Backup Ltda');
    copia.close();
    assert.equal(fs.readFileSync(path.join(pastaBackup, 'anexos', 'a.pdf'), 'utf8'), '%PDF');

    const r2 = await fazerBackup({ db, pastaDados, pastaBackup, manterDias: 30 });
    assert.equal(r2.anexosCopiados, 0, 'anexo já copiado não é copiado de novo');
    db.close();
  } finally {
    fs.rmSync(pastaDados, { recursive: true, force: true });
  }
});
