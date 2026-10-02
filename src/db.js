'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Solicitações guardam as notas fiscais. Tomador, descrição e valor são opcionais porque a
// nota pode ser registrada pelo escritório só com número e data de emissão.
const tabelaSolicitacoes = (nome) => `CREATE TABLE IF NOT EXISTS ${nome} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  criado_por INTEGER NOT NULL REFERENCES usuarios(id),
  tipo_nota TEXT CHECK (tipo_nota IS NULL OR tipo_nota IN ('NFS-e', 'NF-e')),
  tomador_documento TEXT,
  tomador_nome TEXT,
  tomador_email TEXT,
  tomador_endereco TEXT,
  descricao TEXT,
  valor_centavos INTEGER CHECK (valor_centavos IS NULL OR valor_centavos > 0),
  data_competencia TEXT,
  observacoes TEXT,
  status TEXT NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente', 'em_emissao', 'emitida', 'rejeitada', 'cancelada')),
  numero_nota TEXT,
  motivo_rejeicao TEXT,
  responsavel_id INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now')),
  data_emissao TEXT,
  canal_pedido TEXT,
  canal_outro TEXT,
  data_pedido TEXT
);`;

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

${tabelaSolicitacoes('solicitacoes')}
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

CREATE TABLE IF NOT EXISTS ocorrencia_anexos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ocorrencia_id INTEGER NOT NULL REFERENCES ocorrencias(id) ON DELETE CASCADE,
  nome_arquivo TEXT NOT NULL,
  arquivo TEXT NOT NULL,
  tipo_mime TEXT NOT NULL,
  tamanho INTEGER NOT NULL,
  enviado_por INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Documentos recebidos do Questor Zen pelo webhook (postados no Zen para o cliente).
CREATE TABLE IF NOT EXISTS zen_documentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zen_id TEXT,
  empresa_id INTEGER REFERENCES empresas(id) ON DELETE SET NULL,
  associacao TEXT,
  titulo TEXT,
  categoria TEXT,
  categoria_id TEXT,
  status TEXT,
  observacao TEXT,
  cliente_nome TEXT,
  destinatarios_emails TEXT,
  data_criacao TEXT,
  vencimento TEXT,
  competencia TEXT,
  valor_centavos INTEGER,
  nome_arquivo TEXT,
  arquivo TEXT,
  tipo_mime TEXT,
  tamanho INTEGER,
  arquivo_info TEXT,
  tipo_conteudo TEXT,
  payload TEXT NOT NULL,
  recebido_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_zen_documentos_empresa ON zen_documentos(empresa_id);
CREATE INDEX IF NOT EXISTS idx_zen_documentos_zen_id ON zen_documentos(zen_id);

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
    responsavel_id: 'INTEGER REFERENCES usuarios(id)',
    nome_fantasia: 'TEXT',
    regime: 'TEXT',
    regime_outro: 'TEXT',
    endereco: 'TEXT',
    cidade: 'TEXT',
    uf: 'TEXT',
    data_contrato: 'TEXT',
    observacoes: 'TEXT',
  },
  usuarios: {
    admin: 'INTEGER NOT NULL DEFAULT 0',
  },
  ocorrencias: {
    tributo: 'TEXT',
    competencia: 'TEXT',
    motivo_outro: 'TEXT',
    causa_outro: 'TEXT',
    tributo_outro: 'TEXT',
  },
};

// Bancos criados antes da versão "notas como registro" têm campos obrigatórios demais em
// solicitacoes; o SQLite não altera restrições, então a tabela é recriada (procedimento
// recomendado pela documentação do SQLite) preservando todos os dados.
function recriarSolicitacoes(db) {
  const colunas = db.prepare('PRAGMA table_info(solicitacoes)').all();
  if (!colunas.length || colunas.some((c) => c.name === 'canal_pedido')) return;
  const comuns = colunas.map((c) => c.name).join(', ');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(tabelaSolicitacoes('solicitacoes_nova'));
    db.exec(`INSERT INTO solicitacoes_nova (${comuns}) SELECT ${comuns} FROM solicitacoes`);
    db.exec('DROP TABLE solicitacoes');
    db.exec('ALTER TABLE solicitacoes_nova RENAME TO solicitacoes');
    db.exec('CREATE INDEX IF NOT EXISTS idx_solicitacoes_empresa ON solicitacoes(empresa_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_solicitacoes_status ON solicitacoes(status)');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function migrar(db) {
  recriarSolicitacoes(db);
  for (const [tabela, colunas] of Object.entries(COLUNAS_NOVAS)) {
    const existentes = new Set(db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name));
    for (const [coluna, definicao] of Object.entries(colunas)) {
      if (!existentes.has(coluna)) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
    }
  }
  // Sempre há um administrador: se nenhum estiver marcado, o primeiro usuário da equipe passa a ser.
  if (!db.prepare("SELECT 1 FROM usuarios WHERE admin = 1 AND papel = 'escritorio' AND ativo = 1").get()) {
    db.prepare(`UPDATE usuarios SET admin = 1 WHERE id = (
      SELECT id FROM usuarios WHERE papel = 'escritorio' AND ativo = 1 ORDER BY id LIMIT 1)`).run();
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
