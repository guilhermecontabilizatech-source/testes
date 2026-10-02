'use strict';

const { ErroValidacao, texto, dataValidaISO, apenasDigitos, CANAIS_PEDIDO } = require('./validacao');

const TIPOS_DEMANDA = {
  nota_fiscal: 'Nota fiscal',
  recalculo: 'Recálculo de guia',
  guia: 'Guia de pagamento',
  declaracao: 'Declaração',
  certidao: 'Certidão',
  folha: 'Folha de pagamento',
  contrato: 'Contrato / alteração contratual',
  atendimento: 'Atendimento / dúvida',
  outro: 'Outro',
};

const PRIORIDADES = { baixa: 'Baixa', media: 'Média', alta: 'Alta', urgente: 'Urgente' };

const STATUS_DEMANDA = {
  aberta: 'Aberta',
  em_andamento: 'Em andamento',
  aguardando_cliente: 'Aguardando cliente',
  concluida: 'Concluída',
  cancelada: 'Cancelada',
};

const ENCERRADAS = ['concluida', 'cancelada'];
const ehGestor = (u) => Boolean(u.admin || u.gestor);

// Colaborador altera as demandas que criou, as suas e as que ainda estão sem responsável;
// gestores e administradores alteram todas.
function podeAlterar(usuario, demanda) {
  return ehGestor(usuario) || demanda.responsavel_id == null
    || demanda.responsavel_id === usuario.id || demanda.criado_por === usuario.id;
}

function registrarRotasDemandas({ rota, db, hoje }) {
  const soEscritorio = { papel: 'escritorio' };

  function registrarHistorico(demandaId, usuarioId, acao, mensagem = null) {
    db.prepare('INSERT INTO demanda_historico (demanda_id, usuario_id, acao, mensagem) VALUES (?, ?, ?, ?)')
      .run(demandaId, usuarioId, acao, mensagem);
  }

  function validarResponsavel(valor) {
    if (valor === undefined || valor === null || valor === '') return null;
    const id = Number(valor);
    if (!db.prepare("SELECT 1 FROM usuarios WHERE id = ? AND papel = 'escritorio' AND ativo = 1").get(id)) {
      throw new ErroValidacao('Responsável inválido: escolha alguém ativo da equipe.');
    }
    return id;
  }

  function validarDemanda(corpo) {
    const empresaId = Number(corpo.empresa_id);
    if (!db.prepare('SELECT 1 FROM empresas WHERE id = ?').get(empresaId)) throw new ErroValidacao('Selecione o cliente.');
    const tipo = corpo.tipo;
    if (!TIPOS_DEMANDA[tipo]) throw new ErroValidacao('Selecione o tipo de demanda.');
    const prioridade = corpo.prioridade || 'media';
    if (!PRIORIDADES[prioridade]) throw new ErroValidacao('Prioridade inválida.');
    const prazo = corpo.prazo ? String(corpo.prazo) : null;
    if (prazo && !dataValidaISO(prazo)) throw new ErroValidacao('Prazo inválido.');
    const canal = corpo.canal || null;
    if (canal && !CANAIS_PEDIDO[canal]) throw new ErroValidacao('Canal inválido.');
    return {
      empresa_id: empresaId,
      titulo: texto('Título', corpo.titulo, { obrigatorio: true, max: 200 }),
      tipo,
      tipo_outro: tipo === 'outro' ? texto('Descrição do tipo', corpo.tipo_outro, { obrigatorio: true, max: 100 }) : null,
      descricao: texto('Descrição', corpo.descricao, { max: 4000 }),
      prioridade,
      responsavel_id: validarResponsavel(corpo.responsavel_id),
      prazo,
      canal,
      canal_outro: canal === 'outro' ? texto('Descrição do canal', corpo.canal_outro, { obrigatorio: true, max: 100 }) : null,
    };
  }

  const CAMPOS = ['empresa_id', 'titulo', 'tipo', 'tipo_outro', 'descricao', 'prioridade', 'responsavel_id', 'prazo', 'canal', 'canal_outro'];

  function buscar(id) {
    const d = db.prepare(`
      SELECT d.*, e.razao_social AS empresa_nome, r.nome AS responsavel_nome, c.nome AS criado_por_nome
      FROM demandas d JOIN empresas e ON e.id = d.empresa_id
      LEFT JOIN usuarios r ON r.id = d.responsavel_id LEFT JOIN usuarios c ON c.id = d.criado_por
      WHERE d.id = ?
    `).get(id);
    if (!d) throw new ErroValidacao('Demanda não encontrada.', 404);
    return { ...d, atrasada: Boolean(d.prazo && d.prazo < hoje() && !ENCERRADAS.includes(d.status)) };
  }

  function exigirPermissao(usuario, d) {
    if (!podeAlterar(usuario, d)) {
      throw new ErroValidacao('Só o responsável, quem criou a demanda ou um gestor pode alterá-la.', 403);
    }
  }

  // Filtros comuns à lista e ao resumo (o status fica de fora do resumo).
  function filtros(query, usuario) {
    const cond = [];
    const params = [];
    const responsavel = query.get('responsavel_id');
    if (responsavel === 'eu') { cond.push('d.responsavel_id = ?'); params.push(usuario.id); }
    else if (responsavel === 'nenhum') cond.push('d.responsavel_id IS NULL');
    else if (responsavel) { cond.push('d.responsavel_id = ?'); params.push(Number(responsavel)); }
    for (const campo of ['empresa_id', 'prioridade', 'tipo']) {
      const valor = query.get(campo);
      if (valor) { cond.push(`d.${campo} = ?`); params.push(campo === 'empresa_id' ? Number(valor) : valor); }
    }
    const busca = query.get('busca');
    if (busca) {
      cond.push('(d.titulo LIKE ? OR d.descricao LIKE ? OR e.razao_social LIKE ? OR e.cnpj LIKE ?)');
      const termo = `%${busca}%`;
      params.push(termo, termo, termo, `%${apenasDigitos(busca) || busca}%`);
    }
    return { cond, params };
  }

  rota('GET', '/api/demandas', ({ query, usuario }) => {
    const { cond, params } = filtros(query, usuario);
    const base = 'FROM demandas d JOIN empresas e ON e.id = d.empresa_id';
    const where = (extra) => {
      const todas = [...cond, ...extra];
      return todas.length ? `WHERE ${todas.join(' AND ')}` : '';
    };

    const resumo = { atrasadas: 0 };
    for (const s of Object.keys(STATUS_DEMANDA)) resumo[s] = 0;
    for (const l of db.prepare(`SELECT d.status, COUNT(*) AS n ${base} ${where([])} GROUP BY d.status`).all(...params)) resumo[l.status] = l.n;
    resumo.atrasadas = db.prepare(`SELECT COUNT(*) AS n ${base} ${where(["d.prazo < ?", "d.status NOT IN ('concluida', 'cancelada')"])}`)
      .get(...params, hoje()).n;

    // status: um status, "abertas" (padrão: tudo que não terminou), "atrasadas" ou "todas".
    const status = query.get('status') || 'abertas';
    const extra = [];
    const extraParams = [];
    if (status === 'abertas') extra.push("d.status NOT IN ('concluida', 'cancelada')");
    else if (status === 'atrasadas') { extra.push("d.status NOT IN ('concluida', 'cancelada')", 'd.prazo < ?'); extraParams.push(hoje()); }
    else if (STATUS_DEMANDA[status]) { extra.push('d.status = ?'); extraParams.push(status); }
    else if (status !== 'todas') throw new ErroValidacao('Status inválido.');

    const lista = db.prepare(`
      SELECT d.id, d.empresa_id, e.razao_social AS empresa_nome, d.titulo, d.tipo, d.tipo_outro, d.prioridade, d.status,
             d.responsavel_id, r.nome AS responsavel_nome, d.criado_por, d.prazo, d.concluida_em, d.criado_em, d.atualizado_em,
             (SELECT COUNT(*) FROM demanda_historico h WHERE h.demanda_id = d.id AND h.acao = 'comentario') AS comentarios
      ${base} LEFT JOIN usuarios r ON r.id = d.responsavel_id
      ${where(extra)}
      ORDER BY CASE WHEN d.status IN ('concluida', 'cancelada') THEN 1 ELSE 0 END,
               CASE d.prioridade WHEN 'urgente' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END,
               d.prazo IS NULL, d.prazo, d.id DESC
      LIMIT 1000
    `).all(...params, ...extraParams).map((d) => ({
      ...d,
      atrasada: Boolean(d.prazo && d.prazo < hoje() && !ENCERRADAS.includes(d.status)),
      pode_alterar: podeAlterar(usuario, d),
    }));
    return { lista, resumo };
  }, soEscritorio);

  rota('GET', '/api/demandas/:id', ({ params, usuario }) => {
    const d = buscar(params.id);
    const historico = db.prepare(`
      SELECT h.id, h.acao, h.mensagem, h.criado_em, u.nome AS usuario_nome
      FROM demanda_historico h LEFT JOIN usuarios u ON u.id = h.usuario_id
      WHERE h.demanda_id = ? ORDER BY h.criado_em, h.id
    `).all(d.id).map((l) => ({ ...l }));
    return { ...d, historico, pode_alterar: podeAlterar(usuario, d), pode_excluir: ehGestor(usuario) };
  }, soEscritorio);

  rota('POST', '/api/demandas', ({ corpo, usuario }) => {
    const d = validarDemanda(corpo);
    const r = db.prepare(`INSERT INTO demandas (${CAMPOS.join(', ')}, criado_por) VALUES (${CAMPOS.map(() => '?').join(', ')}, ?)`)
      .run(...CAMPOS.map((c) => d[c]), usuario.id);
    const id = Number(r.lastInsertRowid);
    registrarHistorico(id, usuario.id, 'criada', null);
    return { id };
  }, soEscritorio);

  rota('PUT', '/api/demandas/:id', ({ params, corpo, usuario }) => {
    const atual = buscar(params.id);
    exigirPermissao(usuario, atual);
    const d = validarDemanda(corpo);
    db.prepare(`UPDATE demandas SET ${CAMPOS.map((c) => `${c} = ?`).join(', ')}, atualizado_em = datetime('now') WHERE id = ?`)
      .run(...CAMPOS.map((c) => d[c]), atual.id);
    const mudancas = [];
    if (d.responsavel_id !== atual.responsavel_id) {
      const nome = d.responsavel_id ? db.prepare('SELECT nome FROM usuarios WHERE id = ?').get(d.responsavel_id).nome : 'ninguém';
      mudancas.push(`Responsável: ${nome}`);
    }
    if (d.prazo !== atual.prazo) mudancas.push(`Prazo: ${d.prazo ? d.prazo.split('-').reverse().join('/') : 'sem prazo'}`);
    if (d.prioridade !== atual.prioridade) mudancas.push(`Prioridade: ${PRIORIDADES[d.prioridade]}`);
    registrarHistorico(atual.id, usuario.id, 'editada', mudancas.join(' · ') || null);
    return { ok: true };
  }, soEscritorio);

  rota('POST', '/api/demandas/:id/status', ({ params, corpo, usuario }) => {
    const atual = buscar(params.id);
    exigirPermissao(usuario, atual);
    const status = corpo.status;
    if (!STATUS_DEMANDA[status]) throw new ErroValidacao('Status inválido.');
    if (status === atual.status) return { ok: true };
    const mensagem = texto('Observação', corpo.mensagem, { max: 2000 });
    if (status === 'cancelada' && !mensagem) throw new ErroValidacao('Informe o motivo do cancelamento.');
    db.prepare("UPDATE demandas SET status = ?, concluida_em = ?, atualizado_em = datetime('now') WHERE id = ?")
      .run(status, status === 'concluida' ? hoje() : null, atual.id);
    registrarHistorico(atual.id, usuario.id, `status:${status}`, mensagem);
    return { ok: true };
  }, soEscritorio);

  rota('POST', '/api/demandas/:id/comentarios', ({ params, corpo, usuario }) => {
    const d = buscar(params.id);
    const mensagem = texto('Comentário', corpo.mensagem, { obrigatorio: true, max: 4000 });
    registrarHistorico(d.id, usuario.id, 'comentario', mensagem);
    db.prepare("UPDATE demandas SET atualizado_em = datetime('now') WHERE id = ?").run(d.id);
    return { ok: true };
  }, soEscritorio);

  rota('DELETE', '/api/demandas/:id', ({ params }) => {
    const d = buscar(params.id);
    db.prepare('DELETE FROM demandas WHERE id = ?').run(d.id);
    return { ok: true };
  }, { papel: 'escritorio', gestor: true });
}

module.exports = { registrarRotasDemandas, TIPOS_DEMANDA, PRIORIDADES, STATUS_DEMANDA, podeAlterar };
