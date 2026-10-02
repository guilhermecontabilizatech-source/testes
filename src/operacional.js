'use strict';

const { ErroValidacao, texto, valorParaCentavos, CANAIS_PEDIDO } = require('./validacao');
const { paraCsv, reais } = require('./csv');
const { transacao } = require('./db');
const { prepararArquivos, gravarArquivos, apagarArquivos, lerArquivo, cabecalhosDownload } = require('./arquivos');

const TIPOS_OCORRENCIA = {
  guia_recalculada: 'Guia recalculada',
  multa: 'Multa',
};

const MOTIVOS = {
  guia_recalculada: {
    cliente_pagou_atrasado: 'Cliente pagou após o vencimento',
    guia_enviada_atrasada: 'Guia enviada após o vencimento',
    informacao_atrasada: 'Cliente enviou informações em atraso',
    retificacao: 'Retificação / alteração de valores',
    outro: 'Outro',
  },
  multa: {
    falta_declaracao: 'Falta de declaração',
    declaracao_atrasada: 'Declaração entregue em atraso',
    guia_apos_vencimento: 'Guia enviada após o vencimento',
    pagamento_atrasado: 'Pagamento em atraso pelo cliente',
    outro: 'Outro',
  },
};

const TRIBUTOS = {
  das: 'DAS (Simples Nacional)',
  darf: 'DARF (federais)',
  dctfweb: 'DCTFWeb / INSS',
  fgts: 'FGTS Digital',
  iss: 'ISS',
  icms: 'ICMS',
  das_mei: 'DAS-MEI',
  outro: 'Outro',
};

const CAUSAS = {
  cliente: 'Cliente',
  escritorio: 'Escritório',
  outro: 'Outro / terceiros',
};

// Limites usados para gerar os alertas do relatório.
const LIMITES = {
  mediaNotasSemPlano: 2, // notas/mês a partir das quais vale oferecer plano
  guiasRecalculadas: 3, // recálculos no período que merecem atenção
};

const PERIODO_PADRAO = { inicio: '2026-10-01', fim: '2026-12-31' };

const dataValida = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));

function validarOcorrencia(db, corpo) {
  const tipo = corpo.tipo;
  if (!TIPOS_OCORRENCIA[tipo]) throw new ErroValidacao('Tipo de ocorrência inválido.');
  if (!MOTIVOS[tipo][corpo.motivo]) throw new ErroValidacao('Selecione o motivo.');
  if (!CAUSAS[corpo.causa]) throw new ErroValidacao('Selecione a causa.');
  const data = String(corpo.data ?? '');
  if (!dataValida(data)) throw new ErroValidacao('Data inválida.');

  const empresaId = Number(corpo.empresa_id);
  if (!db.prepare('SELECT 1 FROM empresas WHERE id = ?').get(empresaId)) {
    throw new ErroValidacao('Selecione a empresa.');
  }

  let valor = null;
  if (corpo.valor !== undefined && corpo.valor !== null && String(corpo.valor).trim() !== '') {
    valor = valorParaCentavos(corpo.valor);
    if (!Number.isInteger(valor) || valor < 0) throw new ErroValidacao('Valor inválido.');
  }

  const tributo = corpo.tributo || null;
  if (tributo && !TRIBUTOS[tributo]) throw new ErroValidacao('Tributo inválido.');
  const competencia = corpo.competencia || null;
  if (competencia && !/^\d{4}-(0[1-9]|1[0-2])$/.test(competencia)) throw new ErroValidacao('Competência inválida (use AAAA-MM).');

  // Toda opção "Outro" exige descrever o que é.
  const outro = (campo, escolhido, rotulo) => (escolhido === 'outro'
    ? texto(`Descrição de "${rotulo}"`, corpo[campo], { obrigatorio: true, max: 200 })
    : null);

  return {
    empresa_id: empresaId,
    tipo,
    tributo,
    tributo_outro: outro('tributo_outro', tributo, 'Tributo: outro'),
    competencia,
    data,
    motivo: corpo.motivo,
    motivo_outro: outro('motivo_outro', corpo.motivo, 'Motivo: outro'),
    causa: corpo.causa,
    causa_outro: outro('causa_outro', corpo.causa, 'Causa: outro'),
    valor_centavos: valor,
    descricao: texto('Descrição', corpo.descricao, { max: 500 }),
  };
}

const CAMPOS_OCORRENCIA = ['empresa_id', 'tipo', 'tributo', 'tributo_outro', 'competencia', 'data', 'motivo', 'motivo_outro',
  'causa', 'causa_outro', 'valor_centavos', 'descricao'];

const normalizarTexto = (t) => String(t ?? '').trim().toLowerCase();

function lerPeriodo(query) {
  const inicio = query.get('inicio') || PERIODO_PADRAO.inicio;
  const fim = query.get('fim') || PERIODO_PADRAO.fim;
  if (!dataValida(inicio) || !dataValida(fim)) throw new ErroValidacao('Período inválido.');
  if (fim < inicio) throw new ErroValidacao('A data final deve ser depois da inicial.');
  const meses = [];
  let [ano, mes] = inicio.slice(0, 7).split('-').map(Number);
  const ultimo = fim.slice(0, 7);
  for (;;) {
    const atual = `${ano}-${String(mes).padStart(2, '0')}`;
    meses.push(atual);
    if (atual >= ultimo) break;
    if (meses.length >= 36) throw new ErroValidacao('Escolha um período de até 36 meses.');
    mes += 1;
    if (mes > 12) { mes = 1; ano += 1; }
  }
  const empresaId = query.get('empresa_id') ? Number(query.get('empresa_id')) : null;
  const responsavelId = query.get('responsavel_id') ? Number(query.get('responsavel_id')) : null;
  return { inicio, fim, meses, empresaId, responsavelId };
}

// Consolida, por empresa, notas solicitadas, guias recalculadas e multas no período.
function calcularRelatorio(db, { inicio, fim, meses, empresaId = null, responsavelId = null }) {
  const empresas = db.prepare(`
    SELECT e.id, e.razao_social, e.cnpj, e.ativo, e.plano_notas, e.plano_nome, e.notas_incluidas, e.honorario_centavos,
           e.responsavel_id, u.nome AS responsavel_nome
    FROM empresas e LEFT JOIN usuarios u ON u.id = e.responsavel_id
    WHERE (? IS NULL OR e.id = ?) AND (? IS NULL OR e.responsavel_id = ?)
    ORDER BY e.razao_social
  `).all(empresaId, empresaId, responsavelId, responsavelId);

  // Cada nota conta no mês da emissão; pedidos ainda não emitidos, no dia do pedido
  // (criado_em fica em UTC; -3h mantém o dia no horário de Brasília).
  const notas = db.prepare(`
    SELECT empresa_id, substr(dia, 1, 7) AS mes, COUNT(*) AS solicitadas, SUM(status = 'emitida') AS emitidas
    FROM (SELECT empresa_id, status, COALESCE(data_emissao, date(criado_em, '-3 hours')) AS dia FROM solicitacoes
          WHERE status <> 'cancelada')
    WHERE dia BETWEEN ? AND ? AND (? IS NULL OR empresa_id = ?)
    GROUP BY empresa_id, mes
  `).all(inicio, fim, empresaId, empresaId);

  const ocorrencias = db.prepare(`
    SELECT empresa_id, tipo, causa, motivo, motivo_outro, COUNT(*) AS quantidade, SUM(valor_centavos) AS valor
    FROM ocorrencias WHERE data BETWEEN ? AND ? AND (? IS NULL OR empresa_id = ?)
    GROUP BY empresa_id, tipo, causa, motivo, motivo_outro
  `).all(inicio, fim, empresaId, empresaId);

  const porEmpresa = new Map(empresas.map((e) => [e.id, {
    id: e.id,
    razao_social: e.razao_social,
    cnpj: e.cnpj,
    ativo: e.ativo,
    plano_notas: e.plano_notas,
    plano_nome: e.plano_nome,
    notas_incluidas: e.notas_incluidas,
    honorario_centavos: e.honorario_centavos,
    responsavel_id: e.responsavel_id,
    responsavel_nome: e.responsavel_nome,
    notas: { por_mes: Object.fromEntries(meses.map((m) => [m, 0])), total: 0, emitidas: 0, media_mensal: 0 },
    meses_acima_franquia: 0,
    guias: { total: 0, cliente: 0, escritorio: 0, outro: 0 },
    multas: { total: 0, valor_centavos: 0, cliente: 0, escritorio: 0, outro: 0, valor_escritorio_centavos: 0 },
    sinais: [],
  }]));

  const totais = {
    notas: 0,
    guias: 0,
    multas: 0,
    multas_valor_centavos: 0,
    por_motivo: [],
    por_causa: { guia_recalculada: { cliente: 0, escritorio: 0, outro: 0 }, multa: { cliente: 0, escritorio: 0, outro: 0 } },
  };

  for (const n of notas) {
    const e = porEmpresa.get(n.empresa_id);
    if (!e || !(n.mes in e.notas.por_mes)) continue;
    e.notas.por_mes[n.mes] += n.solicitadas;
    e.notas.total += n.solicitadas;
    e.notas.emitidas += n.emitidas ?? 0;
    totais.notas += n.solicitadas;
  }

  const motivos = new Map();
  for (const o of ocorrencias) {
    const e = porEmpresa.get(o.empresa_id);
    if (!e) continue;
    if (o.tipo === 'guia_recalculada') {
      e.guias.total += o.quantidade;
      e.guias[o.causa] += o.quantidade;
      totais.guias += o.quantidade;
    } else {
      e.multas.total += o.quantidade;
      e.multas[o.causa] += o.quantidade;
      e.multas.valor_centavos += o.valor ?? 0;
      if (o.causa === 'escritorio') e.multas.valor_escritorio_centavos += o.valor ?? 0;
      totais.multas += o.quantidade;
      totais.multas_valor_centavos += o.valor ?? 0;
    }
    totais.por_causa[o.tipo][o.causa] += o.quantidade;
    // Motivos "Outro" são agrupados pela descrição digitada.
    const chave = `${o.tipo}:${o.motivo}:${o.motivo === 'outro' ? normalizarTexto(o.motivo_outro) : ''}`;
    const rotulo = o.motivo === 'outro' && o.motivo_outro ? `Outro: ${o.motivo_outro}` : MOTIVOS[o.tipo][o.motivo] ?? o.motivo;
    const m = motivos.get(chave) ?? { tipo: o.tipo, motivo: o.motivo, rotulo, quantidade: 0, valor_centavos: 0 };
    m.quantidade += o.quantidade;
    m.valor_centavos += o.valor ?? 0;
    motivos.set(chave, m);
  }
  totais.por_motivo = [...motivos.values()].sort((a, b) => b.quantidade - a.quantidade);

  const resultado = [];
  for (const e of porEmpresa.values()) {
    const temDados = e.notas.total || e.guias.total || e.multas.total;
    if (!e.ativo && !temDados && empresaId == null) continue;

    e.notas.media_mensal = Math.round((e.notas.total / meses.length) * 10) / 10;
    if (e.plano_notas && e.notas_incluidas != null) {
      e.meses_acima_franquia = meses.filter((m) => e.notas.por_mes[m] > e.notas_incluidas).length;
    }
    // Honorário do período dividido pelas demandas (notas + guias + multas): quanto o
    // cliente paga por cada demanda atendida. Base para reajustes.
    e.demandas = e.notas.total + e.guias.total + e.multas.total;
    e.honorario_por_demanda_centavos = e.honorario_centavos && e.demandas
      ? Math.round((e.honorario_centavos * meses.length) / e.demandas)
      : null;
    e.sinais = gerarSinais(e, meses.length);
    resultado.push(e);
  }

  resultado.sort((a, b) => b.sinais.length - a.sinais.length || b.notas.total - a.notas.total
    || a.razao_social.localeCompare(b.razao_social, 'pt-BR'));

  return { inicio, fim, meses, limites: LIMITES, totais, empresas: resultado };
}

function gerarSinais(e, qtdMeses) {
  const sinais = [];
  const reaisTexto = (c) => `R$ ${reais(c)}`;
  if (!e.plano_notas && e.notas.media_mensal >= LIMITES.mediaNotasSemPlano) {
    sinais.push({ tipo: 'upsell', texto: `Sem plano de notas e pediu em média ${String(e.notas.media_mensal).replace('.', ',')} notas/mês: oferecer plano` });
  }
  if (e.meses_acima_franquia > 0) {
    sinais.push({ tipo: 'upsell', texto: `Passou da franquia de ${e.notas_incluidas} notas em ${e.meses_acima_franquia} de ${qtdMeses} meses: revisar plano` });
  }
  if (e.guias.cliente >= 2) {
    sinais.push({ tipo: 'cliente', texto: `${e.guias.cliente} guias recalculadas por atraso do cliente: orientar ou cobrar recálculo` });
  } else if (e.guias.total >= LIMITES.guiasRecalculadas) {
    sinais.push({ tipo: 'cliente', texto: `${e.guias.total} guias recalculadas no período` });
  }
  if (e.multas.cliente > 0) {
    sinais.push({ tipo: 'cliente', texto: `${e.multas.cliente} multa(s) por causa do cliente: reforçar prazos com o cliente` });
  }
  if (e.guias.escritorio > 0 || e.multas.escritorio > 0) {
    const partes = [];
    if (e.guias.escritorio) partes.push(`${e.guias.escritorio} recálculo(s)`);
    if (e.multas.escritorio) partes.push(`${e.multas.escritorio} multa(s) (${reaisTexto(e.multas.valor_escritorio_centavos)})`);
    sinais.push({ tipo: 'qualidade', texto: `Falhas do escritório: ${partes.join(' e ')}: revisar processo` });
  }
  return sinais;
}

function relatorioCsv(rel) {
  const cab = [
    'Empresa', 'CNPJ', 'Responsável', 'Plano de notas', 'Plano', 'Notas incluídas/mês', 'Honorário mensal',
    ...rel.meses.map((m) => `Notas ${m.slice(5)}/${m.slice(0, 4)}`),
    'Total notas', 'Média/mês', 'Meses acima da franquia',
    'Guias recalculadas', 'Guias (cliente)', 'Guias (escritório)',
    'Multas', 'Valor multas', 'Multas (cliente)', 'Multas (escritório)', 'Demandas', 'Honorário por demanda', 'Alertas',
  ];
  const linhas = rel.empresas.map((e) => [
    e.razao_social, e.cnpj, e.responsavel_nome, e.plano_notas ? 'Sim' : 'Não', e.plano_nome, e.notas_incluidas,
    e.honorario_centavos == null ? '' : reais(e.honorario_centavos),
    ...rel.meses.map((m) => e.notas.por_mes[m]),
    e.notas.total, String(e.notas.media_mensal).replace('.', ','), e.meses_acima_franquia,
    e.guias.total, e.guias.cliente, e.guias.escritorio,
    e.multas.total, reais(e.multas.valor_centavos), e.multas.cliente, e.multas.escritorio,
    e.demandas, e.honorario_por_demanda_centavos == null ? '' : reais(e.honorario_por_demanda_centavos),
    e.sinais.map((s) => s.texto).join(' | '),
  ]);
  return paraCsv([cab, ...linhas]);
}

function registrarRotasOperacionais({ rota, db, pastaArquivos }) {
  const soEscritorio = { papel: 'escritorio' };

  rota('GET', '/api/ocorrencias/opcoes', () => ({ tipos: TIPOS_OCORRENCIA, motivos: MOTIVOS, causas: CAUSAS, tributos: TRIBUTOS, canais: CANAIS_PEDIDO }), soEscritorio);

  function anexosDasOcorrencias(ids) {
    const porOcorrencia = new Map(ids.map((id) => [id, []]));
    if (!ids.length) return porOcorrencia;
    const linhas = db.prepare(`
      SELECT id, ocorrencia_id, nome_arquivo, tipo_mime, tamanho, criado_em FROM ocorrencia_anexos
      WHERE ocorrencia_id IN (${ids.map(() => '?').join(', ')}) ORDER BY id
    `).all(...ids);
    for (const a of linhas) porOcorrencia.get(a.ocorrencia_id).push({ ...a });
    return porOcorrencia;
  }

  function inserirAnexos(ocorrenciaId, gravados, usuarioId) {
    const ins = db.prepare(`
      INSERT INTO ocorrencia_anexos (ocorrencia_id, nome_arquivo, arquivo, tipo_mime, tamanho, enviado_por)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const g of gravados) ins.run(ocorrenciaId, g.nome, g.arquivo, g.tipo_mime, g.tamanho, usuarioId);
  }

  rota('GET', '/api/ocorrencias', ({ query }) => {
    const condicoes = [];
    const params = [];
    if (query.get('empresa_id')) { condicoes.push('o.empresa_id = ?'); params.push(Number(query.get('empresa_id'))); }
    if (query.get('tipo')) { condicoes.push('o.tipo = ?'); params.push(query.get('tipo')); }
    if (query.get('causa')) { condicoes.push('o.causa = ?'); params.push(query.get('causa')); }
    if (dataValida(query.get('inicio') ?? '')) { condicoes.push('o.data >= ?'); params.push(query.get('inicio')); }
    if (dataValida(query.get('fim') ?? '')) { condicoes.push('o.data <= ?'); params.push(query.get('fim')); }
    const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
    const lista = db.prepare(`
      SELECT o.*, e.razao_social AS empresa_nome, u.nome AS registrado_por_nome
      FROM ocorrencias o JOIN empresas e ON e.id = o.empresa_id
      LEFT JOIN usuarios u ON u.id = o.registrado_por
      ${where} ORDER BY o.data DESC, o.id DESC LIMIT 1000
    `).all(...params).map((l) => ({ ...l }));
    const anexos = anexosDasOcorrencias(lista.map((o) => o.id));
    for (const o of lista) o.anexos = anexos.get(o.id);
    return lista;
  }, soEscritorio);

  rota('POST', '/api/ocorrencias', ({ corpo, usuario }) => {
    const o = validarOcorrencia(db, corpo);
    const { gravados, desfazer } = gravarArquivos(pastaArquivos, prepararArquivos(corpo.arquivos));
    try {
      const id = transacao(db, () => {
        const r = db.prepare(`
          INSERT INTO ocorrencias (${CAMPOS_OCORRENCIA.join(', ')}, registrado_por)
          VALUES (${CAMPOS_OCORRENCIA.map(() => '?').join(', ')}, ?)
        `).run(...CAMPOS_OCORRENCIA.map((c) => o[c]), usuario.id);
        const novoId = Number(r.lastInsertRowid);
        inserirAnexos(novoId, gravados, usuario.id);
        return novoId;
      });
      return { id, anexos: gravados.length };
    } catch (err) {
      desfazer();
      throw err;
    }
  }, soEscritorio);

  rota('PUT', '/api/ocorrencias/:id', ({ corpo, params }) => {
    const o = validarOcorrencia(db, corpo);
    const r = db.prepare(`
      UPDATE ocorrencias SET ${CAMPOS_OCORRENCIA.map((c) => `${c} = ?`).join(', ')} WHERE id = ?
    `).run(...CAMPOS_OCORRENCIA.map((c) => o[c]), params.id);
    if (!r.changes) throw new ErroValidacao('Ocorrência não encontrada.', 404);
    return { ok: true };
  }, soEscritorio);

  rota('POST', '/api/ocorrencias/:id/anexos', ({ corpo, params, usuario }) => {
    if (!db.prepare('SELECT 1 FROM ocorrencias WHERE id = ?').get(params.id)) {
      throw new ErroValidacao('Ocorrência não encontrada.', 404);
    }
    const preparados = prepararArquivos(corpo.arquivos);
    if (!preparados.length) throw new ErroValidacao('Selecione um arquivo.');
    const { gravados, desfazer } = gravarArquivos(pastaArquivos, preparados);
    try {
      transacao(db, () => inserirAnexos(params.id, gravados, usuario.id));
    } catch (err) {
      desfazer();
      throw err;
    }
    return { anexos: gravados.length };
  }, soEscritorio);

  rota('GET', '/api/ocorrencias/anexos/:id', ({ params, responderBruto }) => {
    const a = db.prepare('SELECT * FROM ocorrencia_anexos WHERE id = ?').get(params.id);
    if (!a) throw new ErroValidacao('Anexo não encontrado.', 404);
    responderBruto(200, lerArquivo(pastaArquivos, a.arquivo), cabecalhosDownload(a));
  }, soEscritorio);

  rota('DELETE', '/api/ocorrencias/:id', ({ params }) => {
    const arquivos = db.prepare('SELECT arquivo FROM ocorrencia_anexos WHERE ocorrencia_id = ?').all(params.id);
    const r = db.prepare('DELETE FROM ocorrencias WHERE id = ?').run(params.id);
    if (!r.changes) throw new ErroValidacao('Ocorrência não encontrada.', 404);
    apagarArquivos(pastaArquivos, arquivos.map((a) => a.arquivo));
    return { ok: true };
  }, soEscritorio);

  rota('GET', '/api/relatorio', ({ query }) => calcularRelatorio(db, lerPeriodo(query)), soEscritorio);

  rota('GET', '/api/relatorio.csv', ({ query, responderBruto }) => {
    const periodo = lerPeriodo(query);
    responderBruto(200, relatorioCsv(calcularRelatorio(db, periodo)), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="relatorio-${periodo.inicio}-a-${periodo.fim}.csv"`,
    });
  }, soEscritorio);
}

module.exports = {
  registrarRotasOperacionais,
  calcularRelatorio,
  TIPOS_OCORRENCIA,
  MOTIVOS,
  CAUSAS,
  TRIBUTOS,
  LIMITES,
  PERIODO_PADRAO,
};
