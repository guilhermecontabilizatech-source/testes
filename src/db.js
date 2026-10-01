'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS empresas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  razao_social TEXT NOT NULL,
  cnpj TEXT NOT NULL UNIQUE,
  email TEXT,
  telefone TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  senha_hash TEXT NOT NULL,
  papel TEXT NOT NULL CHECK (papel IN ('escritorio', 'cliente')),
  empresa_id INTEGER REFERENCES empresas(id),
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (papel = 'escritorio' OR empresa_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS sessoes (
  token TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  expira_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS solicitacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  criado_por INTEGER NOT NULL REFERENCES usuarios(id),
  tipo_nota TEXT NOT NULL CHECK (tipo_nota IN ('NFS-e', 'NF-e')),
  tomador_documento TEXT NOT NULL,
  tomador_nome TEXT NOT NULL,
  tomador_email TEXT,
  tomador_endereco TEXT,
  descricao TEXT NOT NULL,
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  data_competencia TEXT NOT NULL,
  observacoes TEXT,
  status TEXT NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente', 'em_emissao', 'emitida', 'rejeitada', 'cancelada')),
  numero_nota TEXT,
  motivo_rejeicao TEXT,
  responsavel_id INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_solicitacoes_empresa ON solicitacoes(empresa_id);
CREATE INDEX IF NOT EXISTS idx_solicitacoes_status ON solicitacoes(status);

CREATE TABLE IF NOT EXISTS historico (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  solicitacao_id INTEGER NOT NULL REFERENCES solicitacoes(id) ON DELETE CASCADE,
  usuario_id INTEGER REFERENCES usuarios(id),
  acao TEXT NOT NULL,
  mensagem TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_historico_solicitacao ON historico(solicitacao_id);

CREATE TABLE IF NOT EXISTS ocorrencias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('guia_recalculada', 'multa')),
  data TEXT NOT NULL,
  motivo TEXT NOT NULL,
  causa TEXT NOT NULL CHECK (causa IN ('cliente', 'escritorio', 'outro')),
  valor_centavos INTEGER CHECK (valor_centavos IS NULL OR valor_centavos >= 0),
  descricao TEXT,
  registrado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ocorrencias_empresa_data ON ocorrencias(empresa_id, data);

CREATE TABLE IF NOT EXISTS anexos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  solicitacao_id INTEGER NOT NULL REFERENCES solicitacoes(id) ON DELETE CASCADE,
  nome_arquivo TEXT NOT NULL,
  arquivo TEXT NOT NULL,
  tipo_mime TEXT NOT NULL,
  tamanho INTEGER NOT NULL,
  enviado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// Colunas acrescentadas depois da primeira versão; criadas em bancos antigos na abertura.
const COLUNAS_NOVAS = {
  empresas: {
    plano_notas: 'INTEGER NOT NULL DEFAULT 0',
    plano_nome: 'TEXT',
    notas_incluidas: 'INTEGER',
    honorario_centavos: 'INTEGER',
  },
};

function migrar(db) {
  for (const [tabela, colunas] of Object.entries(COLUNAS_NOVAS)) {
    const existentes = new Set(db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name));
    for (const [coluna, definicao] of Object.entries(colunas)) {
      if (!existentes.has(coluna)) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
    }
  }
}

function abrirBanco(caminho) {
  if (caminho !== ':memory:') {
    fs.mkdirSync(path.dirname(caminho), { recursive: true });
  }
  const db = new DatabaseSync(caminho);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrar(db);
  return db;
}

// Executa fn dentro de uma transação, desfazendo tudo em caso de erro.
function transacao(db, fn) {
  db.exec('BEGIN');
  try {
    const resultado = fn();
    db.exec('COMMIT');
    return resultado;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { abrirBanco, transacao };
