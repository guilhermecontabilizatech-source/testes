'use strict';

const crypto = require('node:crypto');
const { ErroValidacao, texto, dataValidaISO } = require('./validacao');
const { transacao } = require('./db');

const TIPOS_PESQUISA = {
  completa: 'NPS + satisfação (CSAT)',
  nps: 'Só NPS (nota de 0 a 10)',
  csat: 'Só satisfação (CSAT, notas de 1 a 5)',
};

const DIMENSOES_CSAT = {
  csat_atendimento: 'Atendimento',
  csat_prazo: 'Cumprimento de prazos',
  csat_qualidade: 'Qualidade do serviço',
  csat_comunicacao: 'Comunicação',
};

const novoToken = () => crypto.randomBytes(24).toString('base64url');
const pedeNps = (tipo) => tipo !== 'csat';
const pedeCsat = (tipo) => tipo !== 'nps';
// Respondida em (UTC) → dia no horário de Brasília.
const DIA_RESPOSTA = "date(p.respondida_em, '-3 hours')";

// NPS = % promotores (9–10) − % detratores (0–6), de −100 a 100.
function resumir(respostas, enviadas) {
  const comNps = respostas.filter((r) => r.nps != null);
  const promotores = comNps.filter((r) => r.nps >= 9).length;
  const detratores = comNps.filter((r) => r.nps <= 6).length;
  const csat = {};
  for (const campo of Object.keys(DIMENSOES_CSAT)) {
    const notas = respostas.map((r) => r[campo]).filter((n) => n != null);
    csat[campo] = notas.length ? Math.round((notas.reduce((t, n) => t + n, 0) / notas.length) * 10) / 10 : null;
  }
  return {
    respostas: respostas.length,
    enviadas,
    taxa_resposta: enviadas ? Math.round((respostas.length / enviadas) * 100) : null,
    nps: comNps.length ? Math.round(((promotores - detratores) / comNps.length) * 100) : null,
    promotores,
    neutros: comNps.length - promotores - detratores,
    detratores,
    csat,
  };
}

function calcularNps(db, { inicio, fim, empresaId = null }) {
  const respostas = db.prepare(`
    SELECT p.nps, ${Object.keys(DIMENSOES_CSAT).map((c) => `p.${c}`).join(', ')}
    FROM pesquisas p WHERE p.respondida_em IS NOT NULL AND ${DIA_RESPOSTA} BETWEEN ? AND ? AND (? IS NULL OR p.empresa_id = ?)
  `).all(inicio, fim, empresaId, empresaId);
  const enviadas = db.prepare(`SELECT COUNT(*) AS n FROM pesquisas p
    WHERE date(p.criado_em, '-3 hours') BETWEEN ? AND ? AND (? IS NULL OR p.empresa_id = ?)`).get(inicio, fim, empresaId, empresaId).n;
  return resumir(respostas, enviadas);
}

function lerNota(valor, rotulo, min, max, obrigatoria) {
  if (valor === undefined || valor === null || valor === '') {
    if (obrigatoria) throw new ErroValidacao(`Responda: ${rotulo}.`);
    return null;
  }
  const n = Number(valor);
  if (!Number.isInteger(n) || n < min || n > max) throw new ErroValidacao(`Nota inválida em "${rotulo}".`);
  return n;
}

function registrarRotasPesquisas({ rota, db, hoje }) {
  const soEscritorio = { papel: 'escritorio' };

  function lerCriacao(corpo) {
    const tipo = corpo.tipo || 'completa';
    if (!TIPOS_PESQUISA[tipo]) throw new ErroValidacao('Tipo de pesquisa inválido.');
    const dias = Number(corpo.validade_dias ?? 30);
    if (!Number.isInteger(dias) || dias < 1 || dias > 180) throw new ErroValidacao('Validade do link inválida (1 a 180 dias).');
    const expira = new Date(Date.parse(`${hoje()}T12:00:00Z`) + dias * 86400000).toISOString().slice(0, 10);
    return { tipo, expira };
  }

  const inserir = (empresaId, { tipo, expira }, usuarioId) => {
    const token = novoToken();
    const r = db.prepare('INSERT INTO pesquisas (empresa_id, token, tipo, expira_em, criado_por) VALUES (?, ?, ?, ?, ?)')
      .run(empresaId, token, tipo, expira, usuarioId);
    return { id: Number(r.lastInsertRowid), token };
  };

  rota('POST', '/api/pesquisas', ({ corpo, usuario }) => {
    const empresaId = Number(corpo.empresa_id);
    if (!db.prepare('SELECT 1 FROM empresas WHERE id = ?').get(empresaId)) throw new ErroValidacao('Selecione o cliente.');
    return inserir(empresaId, lerCriacao(corpo), usuario.id);
  }, soEscritorio);

  // Um link para cada cliente ativo que ainda não tem pesquisa aguardando resposta.
  rota('POST', '/api/pesquisas/lote', ({ corpo, usuario }) => {
    const config = lerCriacao(corpo);
    const empresas = db.prepare(`
      SELECT id FROM empresas e WHERE ativo = 1 AND NOT EXISTS (
        SELECT 1 FROM pesquisas p WHERE p.empresa_id = e.id AND p.respondida_em IS NULL AND p.expira_em >= ?)
    `).all(hoje());
    transacao(db, () => { for (const e of empresas) inserir(e.id, config, usuario.id); });
    const ativos = db.prepare('SELECT COUNT(*) AS n FROM empresas WHERE ativo = 1').get().n;
    return { criadas: empresas.length, ja_tinham: ativos - empresas.length };
  }, soEscritorio);

  rota('GET', '/api/pesquisas', ({ query }) => {
    const inicio = query.get('inicio') || new Date(Date.parse(`${hoje()}T12:00:00Z`) - 89 * 86400000).toISOString().slice(0, 10);
    const fim = query.get('fim') || hoje();
    if (!dataValidaISO(inicio) || !dataValidaISO(fim) || fim < inicio) throw new ErroValidacao('Período inválido.');
    const empresaId = query.get('empresa_id') ? Number(query.get('empresa_id')) : null;
    const campos = `p.id, p.empresa_id, e.razao_social AS empresa_nome, p.token, p.tipo, p.expira_em, p.criado_em, p.respondida_em,
      p.nps, ${Object.keys(DIMENSOES_CSAT).map((c) => `p.${c}`).join(', ')}, p.comentario, u.nome AS criado_por_nome`;
    const base = 'FROM pesquisas p JOIN empresas e ON e.id = p.empresa_id LEFT JOIN usuarios u ON u.id = p.criado_por';
    // Aguardando resposta: todas, de qualquer data (as vencidas aparecem marcadas).
    const aguardando = db.prepare(`SELECT ${campos} ${base}
      WHERE p.respondida_em IS NULL AND (? IS NULL OR p.empresa_id = ?) ORDER BY p.criado_em DESC, p.id DESC LIMIT 1000`)
      .all(empresaId, empresaId).map((p) => ({ ...p, expirada: p.expira_em < hoje() }));
    const respostas = db.prepare(`SELECT ${campos} ${base}
      WHERE p.respondida_em IS NOT NULL AND ${DIA_RESPOSTA} BETWEEN ? AND ? AND (? IS NULL OR p.empresa_id = ?)
      ORDER BY p.respondida_em DESC LIMIT 1000`).all(inicio, fim, empresaId, empresaId).map((p) => ({ ...p }));
    return { inicio, fim, aguardando, respostas, resumo: calcularNps(db, { inicio, fim, empresaId }) };
  }, soEscritorio);

  // Link ainda não respondido: qualquer um da equipe cancela. Resposta recebida: só gestor ou administrador.
  rota('DELETE', '/api/pesquisas/:id', ({ params, usuario }) => {
    const p = db.prepare('SELECT id, respondida_em FROM pesquisas WHERE id = ?').get(params.id);
    if (!p) throw new ErroValidacao('Pesquisa não encontrada.', 404);
    if (p.respondida_em && !usuario.admin && !usuario.gestor) {
      throw new ErroValidacao('Só gestores e administradores excluem respostas recebidas.', 403);
    }
    db.prepare('DELETE FROM pesquisas WHERE id = ?').run(p.id);
    return { ok: true };
  }, soEscritorio);

  // ---------- página pública (cliente responde sem login) ----------

  function buscarPublica(token) {
    const p = db.prepare(`SELECT p.id, p.tipo, p.expira_em, p.respondida_em, COALESCE(e.nome_fantasia, e.razao_social) AS empresa_nome
      FROM pesquisas p JOIN empresas e ON e.id = p.empresa_id WHERE p.token = ?`).get(token);
    if (!p) throw new ErroValidacao('Pesquisa não encontrada. Confira o link recebido.', 404);
    return { ...p };
  }

  rota('GET', '/api/pesquisa-publica/:token', ({ params }) => {
    const p = buscarPublica(params.token);
    return {
      empresa_nome: p.empresa_nome,
      tipo: p.tipo,
      respondida: Boolean(p.respondida_em),
      expirada: p.expira_em < hoje(),
      dimensoes: pedeCsat(p.tipo) ? DIMENSOES_CSAT : {},
      pede_nps: pedeNps(p.tipo),
    };
  }, { publica: true });

  rota('POST', '/api/pesquisa-publica/:token', ({ params, corpo }) => {
    const p = buscarPublica(params.token);
    if (p.respondida_em) throw new ErroValidacao('Esta pesquisa já foi respondida. Obrigado!', 409);
    if (p.expira_em < hoje()) throw new ErroValidacao('Este link expirou. Peça um novo ao escritório.', 410);
    const nps = pedeNps(p.tipo) ? lerNota(corpo.nps, 'a nota de 0 a 10', 0, 10, true) : null;
    const notas = Object.fromEntries(Object.entries(DIMENSOES_CSAT).map(([campo, rotulo]) => [
      campo, pedeCsat(p.tipo) ? lerNota(corpo[campo], rotulo, 1, 5, true) : null,
    ]));
    const comentario = texto('Comentário', corpo.comentario, { max: 2000 });
    // A condição "respondida_em IS NULL" garante uma única resposta mesmo com dois envios simultâneos.
    const r = db.prepare(`UPDATE pesquisas SET respondida_em = datetime('now'), nps = ?, csat_atendimento = ?, csat_prazo = ?,
      csat_qualidade = ?, csat_comunicacao = ?, comentario = ? WHERE id = ? AND respondida_em IS NULL`)
      .run(nps, notas.csat_atendimento, notas.csat_prazo, notas.csat_qualidade, notas.csat_comunicacao, comentario, p.id);
    if (!r.changes) throw new ErroValidacao('Esta pesquisa já foi respondida. Obrigado!', 409);
    return { ok: true };
  }, { publica: true });
}

module.exports = { registrarRotasPesquisas, calcularNps, TIPOS_PESQUISA, DIMENSOES_CSAT };
