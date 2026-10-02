'use strict';

const { ErroValidacao, REGIMES } = require('./validacao');

// Últimos `quantidade` meses (AAAA-MM) terminando em `mes`, do mais antigo ao mais recente.
function mesesAte(mes, quantidade) {
  const [ano, m] = mes.split('-').map(Number);
  return Array.from({ length: quantidade }, (_, i) => {
    const d = new Date(Date.UTC(ano, m - 1 - (quantidade - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

// Indicadores do dashboard (visão geral do escritório num mês).
function calcularPainel(db, mes) {
  const meses = mesesAte(mes, 6);
  const umValor = (sql, ...params) => db.prepare(sql).get(...params).n ?? 0;

  const clientes = {
    ativos: umValor('SELECT COUNT(*) AS n FROM empresas WHERE ativo = 1'),
    inativos: umValor('SELECT COUNT(*) AS n FROM empresas WHERE ativo = 0'),
    novos_no_mes: umValor("SELECT COUNT(*) AS n FROM empresas WHERE substr(data_contrato, 1, 7) = ?", mes),
    sem_regime: umValor('SELECT COUNT(*) AS n FROM empresas WHERE ativo = 1 AND regime IS NULL'),
    sem_responsavel: umValor('SELECT COUNT(*) AS n FROM empresas WHERE ativo = 1 AND responsavel_id IS NULL'),
    sem_honorario: umValor('SELECT COUNT(*) AS n FROM empresas WHERE ativo = 1 AND honorario_centavos IS NULL'),
  };

  const porRegime = new Map(db.prepare(`
    SELECT COALESCE(regime, '') AS regime, COUNT(*) AS quantidade, SUM(honorario_centavos) AS honorarios
    FROM empresas WHERE ativo = 1 GROUP BY COALESCE(regime, '')
  `).all().map((l) => [l.regime, l]));
  clientes.por_regime = [...Object.keys(REGIMES), '']
    .filter((r) => porRegime.has(r))
    .map((r) => ({
      regime: r || null,
      rotulo: r ? REGIMES[r] : 'Não informado',
      quantidade: porRegime.get(r).quantidade,
      honorarios_centavos: porRegime.get(r).honorarios ?? 0,
    }));

  const base = db.prepare(`
    SELECT SUM(honorario_centavos) AS total, COUNT(honorario_centavos) AS com_valor
    FROM empresas WHERE ativo = 1
  `).get();
  const honorarios = {
    base_mensal_centavos: base.total ?? 0,
    ticket_medio_centavos: base.com_valor ? Math.round(base.total / base.com_valor) : 0,
  };

  // Mesma regra do relatório: nota conta no mês da emissão; pedidos ainda não emitidos, no dia do pedido.
  const notasPorMes = new Map(db.prepare(`
    SELECT substr(COALESCE(data_emissao, date(criado_em, '-3 hours')), 1, 7) AS mes, COUNT(*) AS n
    FROM solicitacoes WHERE status = 'emitida' GROUP BY mes
  `).all().map((l) => [l.mes, l.n]));
  const ocorrenciasPorMes = db.prepare(`
    SELECT substr(data, 1, 7) AS mes, tipo, causa, COUNT(*) AS n, SUM(valor_centavos) AS valor
    FROM ocorrencias WHERE substr(data, 1, 7) BETWEEN ? AND ? GROUP BY mes, tipo, causa
  `).all(meses[0], mes);

  const serie = meses.map((m) => {
    const doMes = ocorrenciasPorMes.filter((o) => o.mes === m);
    const soma = (tipo, campo = 'n') => doMes.filter((o) => o.tipo === tipo).reduce((t, o) => t + (o[campo] ?? 0), 0);
    return { mes: m, notas: notasPorMes.get(m) ?? 0, guias: soma('guia_recalculada'), multas: soma('multa') };
  });

  const doMes = ocorrenciasPorMes.filter((o) => o.mes === mes);
  const multasMes = doMes.filter((o) => o.tipo === 'multa');
  const operacao = {
    notas_emitidas: notasPorMes.get(mes) ?? 0,
    notas_abertas: umValor("SELECT COUNT(*) AS n FROM solicitacoes WHERE status IN ('pendente', 'em_emissao')"),
    guias: serie.at(-1).guias,
    multas: serie.at(-1).multas,
    multas_valor_centavos: multasMes.reduce((t, o) => t + (o.valor ?? 0), 0),
    multas_escritorio: multasMes.filter((o) => o.causa === 'escritorio').reduce((t, o) => t + o.n, 0),
  };

  const zen = {
    recebidos_no_mes: umValor("SELECT COUNT(*) AS n FROM zen_documentos WHERE substr(datetime(recebido_em, '-3 hours'), 1, 7) = ?", mes),
    sem_empresa: umValor('SELECT COUNT(*) AS n FROM zen_documentos WHERE empresa_id IS NULL'),
  };

  // Pendências de cadastro e de operação, com o link da tela que resolve cada uma.
  const alertas = [];
  const alerta = (quantidade, texto, link) => { if (quantidade) alertas.push({ quantidade, texto, link }); };
  alerta(operacao.notas_abertas, 'pedido(s) de nota ainda não emitido(s)', '#/notas?mes=');
  alerta(clientes.sem_regime, 'cliente(s) ativo(s) sem regime tributário', '#/empresas');
  alerta(clientes.sem_honorario, 'cliente(s) ativo(s) sem honorário cadastrado', '#/empresas');
  alerta(clientes.sem_responsavel, 'cliente(s) ativo(s) sem responsável no escritório', '#/empresas');
  alerta(zen.sem_empresa, 'documento(s) do Questor Zen sem empresa associada', '#/zen');

  return { mes, meses, clientes, honorarios, operacao, zen, serie, alertas };
}

function registrarRotasPainel({ rota, db, hoje }) {
  rota('GET', '/api/painel', ({ query }) => {
    const mes = query.get('mes') || hoje().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) throw new ErroValidacao('Mês inválido.');
    return calcularPainel(db, mes);
  }, { papel: 'escritorio' });
}

module.exports = { registrarRotasPainel, calcularPainel, mesesAte };
