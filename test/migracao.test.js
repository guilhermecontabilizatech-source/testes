'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { abrirBanco } = require('../src/db');

test('banco da versão anterior: solicitações recriadas sem perder dados nem vínculos', () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'notas-mig-'));
  const arquivo = path.join(pasta, 'antigo.db');
  try {
    const antigo = new DatabaseSync(arquivo);
    antigo.exec(`
      CREATE TABLE empresas (id INTEGER PRIMARY KEY, razao_social TEXT NOT NULL, cnpj TEXT NOT NULL UNIQUE, email TEXT,
        telefone TEXT, ativo INTEGER NOT NULL DEFAULT 1, criado_em TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE usuarios (id INTEGER PRIMARY KEY, nome TEXT NOT NULL, email TEXT NOT NULL UNIQUE, senha_hash TEXT NOT NULL,
        papel TEXT NOT NULL, empresa_id INTEGER, ativo INTEGER NOT NULL DEFAULT 1, criado_em TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE solicitacoes (id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER NOT NULL REFERENCES empresas(id),
        criado_por INTEGER NOT NULL REFERENCES usuarios(id), tipo_nota TEXT NOT NULL, tomador_documento TEXT NOT NULL,
        tomador_nome TEXT NOT NULL, tomador_email TEXT, tomador_endereco TEXT, descricao TEXT NOT NULL,
        valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0), data_competencia TEXT NOT NULL, observacoes TEXT,
        status TEXT NOT NULL DEFAULT 'pendente', numero_nota TEXT, motivo_rejeicao TEXT, responsavel_id INTEGER,
        criado_em TEXT NOT NULL DEFAULT (datetime('now')), atualizado_em TEXT NOT NULL DEFAULT (datetime('now')), data_emissao TEXT);
      CREATE TABLE historico (id INTEGER PRIMARY KEY, solicitacao_id INTEGER NOT NULL REFERENCES solicitacoes(id) ON DELETE CASCADE,
        usuario_id INTEGER, acao TEXT NOT NULL, mensagem TEXT, criado_em TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO empresas (razao_social, cnpj) VALUES ('Antiga', '11222333000181');
      INSERT INTO usuarios (nome, email, senha_hash, papel) VALUES ('X', 'x@x.com', 'h', 'escritorio');
      INSERT INTO solicitacoes (empresa_id, criado_por, tipo_nota, tomador_documento, tomador_nome, descricao, valor_centavos,
        data_competencia, status, numero_nota) VALUES (1, 1, 'NFS-e', '52998224725', 'T', 'D', 100, '2026-10-01', 'emitida', '77');
      INSERT INTO historico (solicitacao_id, acao) VALUES (1, 'criada');
    `);
    antigo.close();

    const db = abrirBanco(arquivo);
    const s = db.prepare('SELECT * FROM solicitacoes').get();
    assert.equal(s.numero_nota, '77');
    assert.equal(s.tomador_nome, 'T');
    assert.equal(s.canal_pedido, null);
    // Agora uma nota pode ser registrada só com número e data.
    db.prepare("INSERT INTO solicitacoes (empresa_id, criado_por, status, numero_nota, data_emissao) VALUES (1, 1, 'emitida', '78', '2026-10-02')").run();
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    // O histórico continua ligado às solicitações (exclusão em cascata).
    db.prepare('DELETE FROM solicitacoes WHERE id = 1').run();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM historico').get().n, 0);
    const e = db.prepare('SELECT * FROM empresas').get();
    assert.equal(e.responsavel_id, null);
    db.close();

    // Reabrir não refaz a migração.
    const de_novo = abrirBanco(arquivo);
    assert.equal(de_novo.prepare('SELECT COUNT(*) AS n FROM solicitacoes').get().n, 1);
    de_novo.close();
  } finally {
    fs.rmSync(pasta, { recursive: true, force: true });
  }
});
