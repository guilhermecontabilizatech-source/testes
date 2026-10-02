'use strict';

const { ErroValidacao, texto, dataValidaISO, valorParaCentavos, REGIMES } = require('./validacao');
const { TRIBUTOS } = require('./operacional');
const { transacao } = require('./db');

// Situação mostrada na tela: o status gravado mais o "vencido", que depende do dia de hoje.
const SITUACOES_VENCIMENTO = {
  a_vencer: 'A vencer',
  vencido: 'Vencido',
  pago: 'Pago',
  cancelado: 'Cancelado',
};

const situacaoSql = (hojeParam) => `CASE WHEN v.status <> 'pendente' THEN v.status
  WHEN v.vencimento < ${hojeParam} THEN 'vencido' ELSE 'a_vencer' END`;

function lerValor(rotulo, valor) {
  if (valor === undefined || valor === null || String(valor).trim() === '') return null;
  const centavos = valorParaCentavos(valor);
  if (!Number.isInteger(centavos) || centavos < 0) throw new ErroValidacao(`${rotulo} inválido.`);
  return centavos;
}

function lerData(rotulo, valor, { obrigatoria = false } = {}) {
  if (!valor) {
    if (obrigatoria) throw new ErroValidacao(`Informe ${rotulo}.`);
    return null;
  }
  if (!dataValidaISO(String(valor))) throw new ErroValidacao(`${rotulo[0].toUpperCase()}${rotulo.slice(1)} inválida.`);
  return String(valor);
}

function lerCompetencia(valor, { obrigatoria = false } = {}) {
  if (!valor) {
    if (obrigatoria) throw new ErroValidacao('Informe a competência.');
    return null;
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(valor))) throw new ErroValidacao('Competência inválida (use mês/ano).');
  return String(valor);
}

function lerTributo(corpo) {
  if (!TRIBUTOS[corpo.tributo]) throw new ErroValidacao('Selecione o tributo.');
  return {
    tributo: corpo.tributo,
    tributo_outro: corpo.tributo === 'outro' ? texto('Descrição do tributo', corpo.tributo_outro, { obrigatorio: true, max: 100 }) : null,
  };
}

function registrarRotasVencimentos({ rota, db, hoje }) {
  const soEscritorio = { papel: 'escritorio' };

  function validar(corpo) {
    const empresaId = Number(corpo.empresa_id);
    if (!db.prepare('SELECT 1 FROM empresas WHERE id = ?').get(empresaId)) throw new ErroValidacao('Selecione o cliente.');
    return {
      empresa_id: empresaId,
      ...lerTributo(corpo),
      descricao: texto('Descrição', corpo.descricao, { max: 200 }),
      competencia: lerCompetencia(corpo.competencia),
      vencimento: lerData('a data de vencimento', corpo.vencimento, { obrigatoria: true }),
      valor_centavos: lerValor('Valor', corpo.valor),
      codigo_barras: texto('Código de barras', corpo.codigo_barras, { max: 100 }),
      observacoes: texto('Observações', corpo.observacoes, { max: 2000 }),
    };
  }

  const CAMPOS = ['empresa_id', 'tributo', 'tributo_outro', 'descricao', 'competencia', 'vencimento', 'valor_centavos', 'codigo_barras', 'observacoes'];

  function buscar(id) {
    const v = db.prepare('SELECT * FROM vencimentos WHERE id = ?').get(id);
    if (!v) throw new ErroValidacao('Vencimento não encontrado.', 404);
    return { ...v };
  }

  rota('GET', '/api/vencimentos', ({ query }) => {
    const cond = [];
    const params = [];
    // Período pela data de vencimento: um mês (padrão: o atual) ou "todos". Os vencidos de meses
    // anteriores entram sempre que se pede a situação "vencido".
    const mes = query.has('mes') ? query.get('mes') : hoje().slice(0, 7);
    if (mes && !/^\d{4}-\d{2}$/.test(mes)) throw new ErroValidacao('Mês inválido.');
    const situacao = query.get('situacao');
    if (situacao && !SITUACOES_VENCIMENTO[situacao]) throw new ErroValidacao('Situação inválida.');
    if (mes && situacao !== 'vencido') { cond.push('substr(v.vencimento, 1, 7) = ?'); params.push(mes); }
    for (const campo of ['empresa_id', 'tributo']) {
      const valor = query.get(campo);
      if (valor) { cond.push(`v.${campo} = ?`); params.push(campo === 'empresa_id' ? Number(valor) : valor); }
    }
    if (query.get('responsavel_id')) { cond.push('e.responsavel_id = ?'); params.push(Number(query.get('responsavel_id'))); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

    const todas = db.prepare(`
      SELECT v.*, ${situacaoSql('?')} AS situacao, e.razao_social AS empresa_nome, e.responsavel_id, r.nome AS responsavel_nome
      FROM vencimentos v JOIN empresas e ON e.id = v.empresa_id LEFT JOIN usuarios r ON r.id = e.responsavel_id
      ${where}
      ORDER BY v.vencimento, e.razao_social, v.id
      LIMIT 3000
    `).all(hoje(), ...params).map((l) => ({ ...l }));

    const resumo = {};
    for (const s of Object.keys(SITUACOES_VENCIMENTO)) resumo[s] = { quantidade: 0, valor_centavos: 0 };
    for (const v of todas) {
      resumo[v.situacao].quantidade++;
      resumo[v.situacao].valor_centavos += (v.situacao === 'pago' ? v.valor_pago_centavos ?? v.valor_centavos : v.valor_centavos) ?? 0;
    }
    resumo.sem_envio = todas.filter((v) => v.situacao === 'a_vencer' && !v.enviada_em).length;
    return { lista: situacao ? todas.filter((v) => v.situacao === situacao) : todas, resumo };
  }, soEscritorio);

  rota('POST', '/api/vencimentos', ({ corpo, usuario }) => {
    const v = validar(corpo);
    const r = db.prepare(`INSERT INTO vencimentos (${CAMPOS.join(', ')}, criado_por) VALUES (${CAMPOS.map(() => '?').join(', ')}, ?)`)
      .run(...CAMPOS.map((c) => v[c]), usuario.id);
    return { id: Number(r.lastInsertRowid) };
  }, soEscritorio);

  rota('PUT', '/api/vencimentos/:id', ({ params, corpo }) => {
    const atual = buscar(params.id);
    const v = validar(corpo);
    db.prepare(`UPDATE vencimentos SET ${CAMPOS.map((c) => `${c} = ?`).join(', ')}, atualizado_em = datetime('now') WHERE id = ?`)
      .run(...CAMPOS.map((c) => v[c]), atual.id);
    return { ok: true };
  }, soEscritorio);

  // Ações do dia a dia: guia enviada ao cliente, pagamento confirmado, cancelamento e reabertura.
  rota('POST', '/api/vencimentos/:id/acao', ({ params, corpo }) => {
    const v = buscar(params.id);
    const data = lerData('a data', corpo.data) ?? hoje();
    switch (corpo.acao) {
      case 'enviar':
        if (v.status !== 'pendente') throw new ErroValidacao('Só guias pendentes podem ser marcadas como enviadas.');
        db.prepare("UPDATE vencimentos SET enviada_em = ?, atualizado_em = datetime('now') WHERE id = ?").run(data, v.id);
        break;
      case 'pagar': {
        if (v.status !== 'pendente') throw new ErroValidacao('Este vencimento não está pendente.');
        const valorPago = lerValor('Valor pago', corpo.valor) ?? v.valor_centavos;
        db.prepare("UPDATE vencimentos SET status = 'pago', pago_em = ?, valor_pago_centavos = ?, atualizado_em = datetime('now') WHERE id = ?")
          .run(data, valorPago, v.id);
        break;
      }
      case 'cancelar':
        if (v.status !== 'pendente') throw new ErroValidacao('Este vencimento não está pendente.');
        db.prepare("UPDATE vencimentos SET status = 'cancelado', atualizado_em = datetime('now') WHERE id = ?").run(v.id);
        break;
      case 'reabrir':
        db.prepare(`UPDATE vencimentos SET status = 'pendente', pago_em = NULL, valor_pago_centavos = NULL,
          atualizado_em = datetime('now') WHERE id = ?`).run(v.id);
        break;
      default:
        throw new ErroValidacao('Ação inválida.');
    }
    return { ok: true };
  }, soEscritorio);

  rota('DELETE', '/api/vencimentos/:id', ({ params }) => {
    const v = buscar(params.id);
    db.prepare('DELETE FROM vencimentos WHERE id = ?').run(v.id);
    return { ok: true };
  }, { papel: 'escritorio', gestor: true });

  // Gera o mesmo vencimento (ex.: DAS da competência) para todos os clientes ativos dos regimes
  // escolhidos. Quem já tem esse tributo nessa competência fica de fora.
  function lerGeracao(corpo) {
    const regimes = Array.isArray(corpo.regimes) ? [...new Set(corpo.regimes)] : [];
    if (!regimes.length) throw new ErroValidacao('Escolha ao menos um regime.');
    if (regimes.some((r) => r !== 'sem_regime' && !REGIMES[r])) throw new ErroValidacao('Regime inválido.');
    return {
      ...lerTributo(corpo),
      competencia: lerCompetencia(corpo.competencia, { obrigatoria: true }),
      vencimento: lerData('a data de vencimento', corpo.vencimento, { obrigatoria: true }),
      regimes,
    };
  }

  function candidatos(g) {
    const comRegime = g.regimes.filter((r) => r !== 'sem_regime');
    const empresas = db.prepare(`
      SELECT id, razao_social, regime FROM empresas
      WHERE ativo = 1 AND (regime IN (${comRegime.map(() => '?').join(', ') || 'NULL'}) OR (? AND regime IS NULL))
      ORDER BY razao_social
    `).all(...comRegime, g.regimes.includes('sem_regime') ? 1 : 0);
    const jaTem = db.prepare(`
      SELECT 1 FROM vencimentos WHERE empresa_id = ? AND tributo = ? AND competencia = ? AND status <> 'cancelado'
        AND (tributo <> 'outro' OR tributo_outro = ?)
    `);
    return empresas.map((e) => ({ ...e, existente: Boolean(jaTem.get(e.id, g.tributo, g.competencia, g.tributo_outro)) }));
  }

  rota('POST', '/api/vencimentos/gerar/previa', ({ corpo }) => {
    const lista = candidatos(lerGeracao(corpo));
    return { novos: lista.filter((e) => !e.existente).length, existentes: lista.filter((e) => e.existente).length, empresas: lista };
  }, soEscritorio);

  rota('POST', '/api/vencimentos/gerar', ({ corpo, usuario }) => {
    const g = lerGeracao(corpo);
    const lista = candidatos(g);
    const inserir = db.prepare(`INSERT INTO vencimentos (empresa_id, tributo, tributo_outro, competencia, vencimento, criado_por)
      VALUES (?, ?, ?, ?, ?, ?)`);
    let criados = 0;
    transacao(db, () => {
      for (const e of lista) {
        if (e.existente) continue;
        inserir.run(e.id, g.tributo, g.tributo_outro, g.competencia, g.vencimento, usuario.id);
        criados++;
      }
    });
    return { criados, ignorados: lista.length - criados };
  }, soEscritorio);
}

module.exports = { registrarRotasVencimentos, SITUACOES_VENCIMENTO };
