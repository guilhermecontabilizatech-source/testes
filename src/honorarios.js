'use strict';

const { ErroValidacao, texto, dataValidaISO, valorParaCentavos, REGIMES } = require('./validacao');
const { paraCsv, reais } = require('./csv');
const { transacao } = require('./db');
const { mesesAte } = require('./painel');

const TIPOS_HONORARIO = {
  mensal: 'Honorário mensal',
  decimo_terceiro: '13º honorário',
  extra: 'Serviço extra',
};

const FORMAS_PAGAMENTO = {
  pix: 'Pix',
  boleto: 'Boleto',
  transferencia: 'Transferência',
  cartao: 'Cartão',
  dinheiro: 'Dinheiro',
  outro: 'Outro',
};

// Situação mostrada na tela: "atrasado" é a cobrança em aberto com vencimento já passado.
const SITUACOES_HONORARIO = {
  aberto: 'Em aberto',
  atrasado: 'Atrasado',
  recebido: 'Recebido',
  cancelado: 'Cancelado',
};

// Tipos gerados em lote: no máximo uma cobrança por cliente e competência.
const TIPOS_UNICOS = ['mensal', 'decimo_terceiro'];

const situacaoSql = "CASE WHEN h.status = 'aberto' AND h.vencimento < ? THEN 'atrasado' ELSE h.status END";
const competenciaValida = (c) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(c ?? ''));
const ultimoDia = (competencia) => {
  const [ano, mes] = competencia.split('-').map(Number);
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
};
const diaNoMes = (competencia, dia) => `${competencia}-${String(Math.min(dia, ultimoDia(competencia))).padStart(2, '0')}`;

function lerValor(rotulo, valor, { obrigatorio = false } = {}) {
  if (valor === undefined || valor === null || String(valor).trim() === '') {
    if (obrigatorio) throw new ErroValidacao(`Informe o ${rotulo.toLowerCase()}.`);
    return null;
  }
  const centavos = valorParaCentavos(valor);
  if (!Number.isInteger(centavos) || centavos <= 0) throw new ErroValidacao(`${rotulo} inválido.`);
  return centavos;
}

function registrarRotasHonorarios({ rota, db, hoje }) {
  // Dados financeiros do escritório: só gestores e administradores.
  const soGestor = { papel: 'escritorio', gestor: true };

  function validar(corpo, idAtual = null) {
    const empresaId = Number(corpo.empresa_id);
    if (!db.prepare('SELECT 1 FROM empresas WHERE id = ?').get(empresaId)) throw new ErroValidacao('Selecione o cliente.');
    const tipo = corpo.tipo || 'mensal';
    if (!TIPOS_HONORARIO[tipo]) throw new ErroValidacao('Tipo de cobrança inválido.');
    if (!competenciaValida(corpo.competencia)) throw new ErroValidacao('Competência inválida (use mês/ano).');
    if (!dataValidaISO(String(corpo.vencimento ?? ''))) throw new ErroValidacao('Data de vencimento inválida.');
    const h = {
      empresa_id: empresaId,
      tipo,
      descricao: texto('Descrição', corpo.descricao, { obrigatorio: tipo === 'extra', max: 200 }),
      competencia: corpo.competencia,
      vencimento: corpo.vencimento,
      valor_centavos: lerValor('Valor', corpo.valor, { obrigatorio: true }),
      nota_numero: texto('Nº da nota do honorário', corpo.nota_numero, { max: 50 }),
      observacoes: texto('Observações', corpo.observacoes, { max: 2000 }),
    };
    if (TIPOS_UNICOS.includes(tipo)) {
      const existente = db.prepare(`SELECT id FROM honorarios
        WHERE empresa_id = ? AND tipo = ? AND competencia = ? AND status <> 'cancelado' AND id IS NOT ?`)
        .get(empresaId, tipo, h.competencia, idAtual);
      if (existente) throw new ErroValidacao(`Este cliente já tem ${TIPOS_HONORARIO[tipo].toLowerCase()} nessa competência.`, 409);
    }
    return h;
  }

  const CAMPOS = ['empresa_id', 'tipo', 'descricao', 'competencia', 'vencimento', 'valor_centavos', 'nota_numero', 'observacoes'];

  function buscar(id) {
    const h = db.prepare('SELECT * FROM honorarios WHERE id = ?').get(id);
    if (!h) throw new ErroValidacao('Cobrança não encontrada.', 404);
    return { ...h };
  }

  function listar(query) {
    const cond = [];
    const params = [];
    // Competência: uma (padrão: a atual) ou todas (vazio). "Atrasado" sempre olha todas.
    const competencia = query.has('competencia') ? query.get('competencia') : hoje().slice(0, 7);
    if (competencia && !competenciaValida(competencia)) throw new ErroValidacao('Competência inválida.');
    const situacao = query.get('situacao');
    if (situacao && !SITUACOES_HONORARIO[situacao]) throw new ErroValidacao('Situação inválida.');
    if (competencia && situacao !== 'atrasado') { cond.push('h.competencia = ?'); params.push(competencia); }
    for (const campo of ['empresa_id', 'tipo']) {
      const valor = query.get(campo);
      if (valor) { cond.push(`h.${campo} = ?`); params.push(campo === 'empresa_id' ? Number(valor) : valor); }
    }
    if (query.get('responsavel_id')) { cond.push('e.responsavel_id = ?'); params.push(Number(query.get('responsavel_id'))); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const todas = db.prepare(`
      SELECT h.*, ${situacaoSql} AS situacao, e.razao_social AS empresa_nome, e.regime
      FROM honorarios h JOIN empresas e ON e.id = h.empresa_id
      ${where}
      ORDER BY h.vencimento, e.razao_social, h.id
      LIMIT 5000
    `).all(hoje(), ...params).map((l) => ({ ...l }));
    const resumo = {};
    for (const s of Object.keys(SITUACOES_HONORARIO)) resumo[s] = { quantidade: 0, valor_centavos: 0 };
    for (const h of todas) {
      resumo[h.situacao].quantidade++;
      resumo[h.situacao].valor_centavos += h.situacao === 'recebido' ? h.valor_recebido_centavos ?? h.valor_centavos : h.valor_centavos;
    }
    return { lista: situacao ? todas.filter((h) => h.situacao === situacao) : todas, resumo };
  }

  rota('GET', '/api/honorarios', ({ query }) => listar(query), soGestor);

  rota('GET', '/api/honorarios.csv', ({ query, responderBruto }) => {
    const { lista } = listar(query);
    const csv = paraCsv([
      ['Cliente', 'Tipo', 'Descrição', 'Competência', 'Vencimento', 'Valor', 'Situação', 'Recebido em', 'Valor recebido',
        'Forma de pagamento', 'Nº nota'],
      ...lista.map((h) => [
        h.empresa_nome, TIPOS_HONORARIO[h.tipo], h.descricao, h.competencia, h.vencimento, reais(h.valor_centavos),
        SITUACOES_HONORARIO[h.situacao], h.recebido_em, h.valor_recebido_centavos == null ? '' : reais(h.valor_recebido_centavos),
        h.forma_pagamento === 'outro' ? `Outro: ${h.forma_outro ?? ''}` : FORMAS_PAGAMENTO[h.forma_pagamento] ?? '', h.nota_numero,
      ]),
    ]);
    responderBruto(200, csv, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="honorarios.csv"',
    });
  }, soGestor);

  rota('POST', '/api/honorarios', ({ corpo, usuario }) => {
    const h = validar(corpo);
    const r = db.prepare(`INSERT INTO honorarios (${CAMPOS.join(', ')}, criado_por) VALUES (${CAMPOS.map(() => '?').join(', ')}, ?)`)
      .run(...CAMPOS.map((c) => h[c]), usuario.id);
    return { id: Number(r.lastInsertRowid) };
  }, soGestor);

  rota('PUT', '/api/honorarios/:id', ({ params, corpo }) => {
    const atual = buscar(params.id);
    const h = validar(corpo, atual.id);
    db.prepare(`UPDATE honorarios SET ${CAMPOS.map((c) => `${c} = ?`).join(', ')}, atualizado_em = datetime('now') WHERE id = ?`)
      .run(...CAMPOS.map((c) => h[c]), atual.id);
    return { ok: true };
  }, soGestor);

  rota('POST', '/api/honorarios/:id/acao', ({ params, corpo }) => {
    const h = buscar(params.id);
    switch (corpo.acao) {
      case 'receber': {
        if (h.status !== 'aberto') throw new ErroValidacao('Esta cobrança não está em aberto.');
        const data = corpo.data ? String(corpo.data) : hoje();
        if (!dataValidaISO(data)) throw new ErroValidacao('Data do recebimento inválida.');
        const forma = corpo.forma_pagamento || null;
        if (forma && !FORMAS_PAGAMENTO[forma]) throw new ErroValidacao('Forma de pagamento inválida.');
        const formaOutro = forma === 'outro' ? texto('Descrição da forma de pagamento', corpo.forma_outro, { obrigatorio: true, max: 100 }) : null;
        const valor = lerValor('Valor recebido', corpo.valor) ?? h.valor_centavos;
        db.prepare(`UPDATE honorarios SET status = 'recebido', recebido_em = ?, valor_recebido_centavos = ?, forma_pagamento = ?,
          forma_outro = ?, atualizado_em = datetime('now') WHERE id = ?`).run(data, valor, forma, formaOutro, h.id);
        break;
      }
      case 'cancelar':
        if (h.status !== 'aberto') throw new ErroValidacao('Esta cobrança não está em aberto.');
        db.prepare("UPDATE honorarios SET status = 'cancelado', atualizado_em = datetime('now') WHERE id = ?").run(h.id);
        break;
      case 'reabrir':
        if (TIPOS_UNICOS.includes(h.tipo) && h.status === 'cancelado') {
          const outra = db.prepare(`SELECT 1 FROM honorarios WHERE empresa_id = ? AND tipo = ? AND competencia = ?
            AND status <> 'cancelado' AND id <> ?`).get(h.empresa_id, h.tipo, h.competencia, h.id);
          if (outra) throw new ErroValidacao('Já existe outra cobrança desse tipo nessa competência.', 409);
        }
        db.prepare(`UPDATE honorarios SET status = 'aberto', recebido_em = NULL, valor_recebido_centavos = NULL,
          forma_pagamento = NULL, forma_outro = NULL, atualizado_em = datetime('now') WHERE id = ?`).run(h.id);
        break;
      default:
        throw new ErroValidacao('Ação inválida.');
    }
    return { ok: true };
  }, soGestor);

  rota('DELETE', '/api/honorarios/:id', ({ params }) => {
    const h = buscar(params.id);
    db.prepare('DELETE FROM honorarios WHERE id = ?').run(h.id);
    return { ok: true };
  }, soGestor);

  // Geração do mês: uma cobrança (mensal ou 13º) para cada cliente ativo com honorário cadastrado,
  // pelo valor do cadastro e no dia de vencimento do cliente (ou no dia padrão informado).
  function lerGeracao(corpo) {
    const tipo = corpo.tipo || 'mensal';
    if (!TIPOS_UNICOS.includes(tipo)) throw new ErroValidacao('Gere em lote só honorário mensal ou 13º.');
    if (!competenciaValida(corpo.competencia)) throw new ErroValidacao('Competência inválida (use mês/ano).');
    const diaPadrao = Number(corpo.dia_padrao);
    if (!Number.isInteger(diaPadrao) || diaPadrao < 1 || diaPadrao > 31) throw new ErroValidacao('Dia de vencimento padrão inválido (1 a 31).');
    return { tipo, competencia: corpo.competencia, diaPadrao };
  }

  function candidatos(g) {
    const jaTem = db.prepare(`SELECT 1 FROM honorarios WHERE empresa_id = ? AND tipo = ? AND competencia = ? AND status <> 'cancelado'`);
    return db.prepare(`
      SELECT id, razao_social, honorario_centavos, dia_vencimento FROM empresas
      WHERE ativo = 1 AND honorario_centavos > 0 ORDER BY razao_social
    `).all().map((e) => ({
      ...e,
      vencimento: diaNoMes(g.competencia, e.dia_vencimento ?? g.diaPadrao),
      existente: Boolean(jaTem.get(e.id, g.tipo, g.competencia)),
    }));
  }

  rota('POST', '/api/honorarios/gerar/previa', ({ corpo }) => {
    const lista = candidatos(lerGeracao(corpo));
    const novos = lista.filter((e) => !e.existente);
    return {
      novos: novos.length,
      existentes: lista.length - novos.length,
      valor_centavos: novos.reduce((t, e) => t + e.honorario_centavos, 0),
      sem_honorario: db.prepare('SELECT COUNT(*) AS n FROM empresas WHERE ativo = 1 AND COALESCE(honorario_centavos, 0) <= 0').get().n,
      empresas: lista,
    };
  }, soGestor);

  rota('POST', '/api/honorarios/gerar', ({ corpo, usuario }) => {
    const g = lerGeracao(corpo);
    const lista = candidatos(g);
    const inserir = db.prepare(`INSERT INTO honorarios (empresa_id, tipo, competencia, vencimento, valor_centavos, criado_por)
      VALUES (?, ?, ?, ?, ?, ?)`);
    let criados = 0;
    transacao(db, () => {
      for (const e of lista) {
        if (e.existente) continue;
        inserir.run(e.id, g.tipo, g.competencia, e.vencimento, e.honorario_centavos, usuario.id);
        criados++;
      }
    });
    return { criados, ignorados: lista.length - criados };
  }, soGestor);

  rota('GET', '/api/receita', ({ query }) => {
    const mes = query.get('mes') || hoje().slice(0, 7);
    if (!competenciaValida(mes)) throw new ErroValidacao('Mês inválido.');
    return calcularReceita(db, mes, hoje());
  }, soGestor);
}

// Receita do escritório: recorrente (cadastro), faturado (por competência), recebido (pela data
// do recebimento, regime de caixa) e atrasos.
function calcularReceita(db, mes, hoje) {
  const meses = mesesAte(mes, 6);
  const umaLinha = (sql, ...p) => db.prepare(sql).get(...p);

  const recorrente = umaLinha('SELECT SUM(honorario_centavos) AS total, COUNT(*) AS clientes FROM empresas WHERE ativo = 1 AND honorario_centavos > 0');
  const faturadoPorMes = new Map(db.prepare(`
    SELECT competencia AS mes, SUM(valor_centavos) AS total FROM honorarios
    WHERE status <> 'cancelado' AND competencia BETWEEN ? AND ? GROUP BY competencia
  `).all(meses[0], mes).map((l) => [l.mes, l.total]));
  const recebidoPorMes = new Map(db.prepare(`
    SELECT substr(recebido_em, 1, 7) AS mes, SUM(COALESCE(valor_recebido_centavos, valor_centavos)) AS total FROM honorarios
    WHERE status = 'recebido' AND substr(recebido_em, 1, 7) BETWEEN ? AND ? GROUP BY mes
  `).all(meses[0], mes).map((l) => [l.mes, l.total]));
  const serie = meses.map((m) => ({ mes: m, faturado_centavos: faturadoPorMes.get(m) ?? 0, recebido_centavos: recebidoPorMes.get(m) ?? 0 }));

  const atraso = umaLinha(`SELECT SUM(valor_centavos) AS total, COUNT(*) AS cobrancas, COUNT(DISTINCT empresa_id) AS clientes
    FROM honorarios WHERE status = 'aberto' AND vencimento < ?`, hoje);
  const atrasoDoMes = umaLinha("SELECT SUM(valor_centavos) AS total FROM honorarios WHERE status = 'aberto' AND vencimento < ? AND competencia = ?", hoje, mes).total ?? 0;
  const faturadoMes = faturadoPorMes.get(mes) ?? 0;

  const porTipo = Object.fromEntries(Object.keys(TIPOS_HONORARIO).map((t) => [t, 0]));
  for (const l of db.prepare("SELECT tipo, SUM(valor_centavos) AS total FROM honorarios WHERE status <> 'cancelado' AND competencia = ? GROUP BY tipo").all(mes)) {
    porTipo[l.tipo] = l.total;
  }

  // Por cliente: ativos com honorário e quem tem cobrança na competência ou atraso.
  const clientes = db.prepare(`
    SELECT e.id, e.razao_social, e.regime, e.regime_outro, e.ativo, e.honorario_centavos,
      (SELECT SUM(valor_centavos) FROM honorarios h WHERE h.empresa_id = e.id AND h.competencia = ? AND h.status <> 'cancelado') AS faturado,
      (SELECT SUM(COALESCE(valor_recebido_centavos, valor_centavos)) FROM honorarios h
        WHERE h.empresa_id = e.id AND h.competencia = ? AND h.status = 'recebido') AS recebido,
      (SELECT SUM(valor_centavos) FROM honorarios h WHERE h.empresa_id = e.id AND h.competencia = ? AND h.status = 'aberto') AS em_aberto,
      (SELECT SUM(valor_centavos) FROM honorarios h WHERE h.empresa_id = e.id AND h.status = 'aberto' AND h.vencimento < ?) AS atrasado,
      (SELECT MIN(vencimento) FROM honorarios h WHERE h.empresa_id = e.id AND h.status = 'aberto' AND h.vencimento < ?) AS atrasado_desde
    FROM empresas e
  `).all(mes, mes, mes, hoje, hoje)
    .map((c) => ({
      id: c.id, razao_social: c.razao_social, regime: c.regime, regime_outro: c.regime_outro, ativo: c.ativo,
      honorario_centavos: c.honorario_centavos, faturado_centavos: c.faturado ?? 0, recebido_centavos: c.recebido ?? 0,
      em_aberto_centavos: c.em_aberto ?? 0, atrasado_centavos: c.atrasado ?? 0, atrasado_desde: c.atrasado_desde,
    }))
    .filter((c) => (c.ativo && c.honorario_centavos > 0) || c.faturado_centavos || c.atrasado_centavos)
    .sort((a, b) => b.atrasado_centavos - a.atrasado_centavos || b.faturado_centavos - a.faturado_centavos
      || a.razao_social.localeCompare(b.razao_social, 'pt-BR'));

  const porRegime = new Map();
  for (const c of clientes) {
    const chave = c.regime ?? '';
    const r = porRegime.get(chave) ?? { regime: c.regime, rotulo: c.regime ? REGIMES[c.regime] : 'Não informado', recorrente_centavos: 0, clientes: 0 };
    if (c.ativo && c.honorario_centavos > 0) { r.recorrente_centavos += c.honorario_centavos; r.clientes++; }
    porRegime.set(chave, r);
  }

  return {
    mes,
    meses,
    recorrente_centavos: recorrente.total ?? 0,
    clientes_com_honorario: recorrente.clientes,
    faturado_centavos: faturadoMes,
    recebido_centavos: recebidoPorMes.get(mes) ?? 0,
    atrasado: { valor_centavos: atraso.total ?? 0, cobrancas: atraso.cobrancas, clientes: atraso.clientes },
    inadimplencia_mes: faturadoMes ? Math.round((atrasoDoMes / faturadoMes) * 1000) / 10 : 0,
    por_tipo: porTipo,
    por_regime: [...porRegime.values()].filter((r) => r.clientes).sort((a, b) => b.recorrente_centavos - a.recorrente_centavos),
    serie,
    clientes,
  };
}

module.exports = { registrarRotasHonorarios, calcularReceita, TIPOS_HONORARIO, FORMAS_PAGAMENTO, SITUACOES_HONORARIO };
