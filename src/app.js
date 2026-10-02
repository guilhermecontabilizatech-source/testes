'use strict';

const fs = require('node:fs');
const path = require('node:path');
const auth = require('./auth');
const { transacao } = require('./db');
const { paraCsv } = require('./csv');
const { registrarRotasOperacionais } = require('./operacional');
const { prepararArquivo, prepararArquivos, gravarArquivos, apagarArquivos, lerArquivo, cabecalhosDownload } = require('./arquivos');
const { lerXmlNota } = require('./xmlNota');
const { criarLimitador } = require('./limitador');
const importacao = require('./importacao');
const {
  ErroValidacao,
  apenasDigitos,
  cnpjValido,
  emailValido,
  texto,
  validarSolicitacao,
  validarNota,
  valorParaCentavos,
  CANAIS_PEDIDO,
} = require('./validacao');

const LIMITE_CORPO = 30 * 1024 * 1024; // anexos chegam em base64 (até 10 MB cada)
const PASTA_PUBLICA = path.join(__dirname, '..', 'public');
const MIME_ESTATICO = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// Transições de status permitidas e quem pode realizá-las.
const TRANSICOES = {
  pendente: { em_emissao: ['escritorio'], rejeitada: ['escritorio'], cancelada: ['escritorio', 'cliente'] },
  em_emissao: { emitida: ['escritorio'], rejeitada: ['escritorio'], pendente: ['escritorio'] },
  rejeitada: { cancelada: ['escritorio', 'cliente'] },
  emitida: { cancelada: ['escritorio'] },
  cancelada: {},
};

const ROTULOS_STATUS = {
  pendente: 'Pendente',
  em_emissao: 'Em emissão',
  emitida: 'Emitida',
  rejeitada: 'Rejeitada',
  cancelada: 'Cancelada',
};

const reaisTexto = (centavos) => (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Data de hoje (AAAA-MM-DD) no horário de Brasília.
function hojeBrasilia() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Data de referência de uma nota: a emissão; para pedidos ainda não emitidos, o dia do pedido
// (criado_em fica em UTC; -3h mantém o dia no horário de Brasília).
const DATA_NOTA = "COALESCE(s.data_emissao, date(s.criado_em, '-3 hours'))";

function criarApp({
  db, pastaArquivos, cookieSeguro = false, confiarProxy = false, limitador = criarLimitador(), acessoClientes = false,
}) {
  fs.mkdirSync(pastaArquivos, { recursive: true });

  const rotas = [];
  const rota = (metodo, padrao, handler, { publica = false, papel = null, admin = false } = {}) => {
    const regex = new RegExp(`^${padrao.replace(/\./g, '\\.').replace(/:(\w+)/g, '(?<$1>\\d+)')}$`);
    rotas.push({ metodo, regex, handler, publica, papel, admin });
  };

  // ---------- utilitários ----------

  function registrarHistorico(solicitacaoId, usuarioId, acao, mensagem = null) {
    db.prepare('INSERT INTO historico (solicitacao_id, usuario_id, acao, mensagem) VALUES (?, ?, ?, ?)')
      .run(solicitacaoId, usuarioId, acao, mensagem);
  }

  function inserirAnexos(solicitacaoId, gravados, usuarioId) {
    const ins = db.prepare(`
      INSERT INTO anexos (solicitacao_id, nome_arquivo, arquivo, tipo_mime, tamanho, enviado_por)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    return gravados.map((g) => {
      const r = ins.run(solicitacaoId, g.nome, g.arquivo, g.tipo_mime, g.tamanho, usuarioId);
      registrarHistorico(solicitacaoId, usuarioId, 'anexo', `Arquivo anexado: ${g.nome}`);
      return Number(r.lastInsertRowid);
    });
  }

  function verificarNotaDuplicada(empresaId, numero, ignorarId) {
    const existente = db.prepare(`
      SELECT id FROM solicitacoes WHERE empresa_id = ? AND numero_nota = ? AND status <> 'cancelada' AND id IS NOT ?
    `).get(empresaId, numero, ignorarId);
    if (existente) throw new ErroValidacao(`A nota nº ${numero} já está registrada (solicitação #${existente.id}).`, 409);
  }

  // Solicitações em aberto da empresa; sugere a que bate com tomador (e valor) da nota.
  function solicitacoesAbertas(empresaId, nota) {
    const lista = db.prepare(`
      SELECT id, tipo_nota, tomador_nome, tomador_documento, valor_centavos, status, criado_em
      FROM solicitacoes WHERE empresa_id = ? AND status IN ('pendente', 'em_emissao') ORDER BY criado_em, id
    `).all(empresaId).map((l) => ({ ...l }));
    const doTomador = lista.filter((s) => nota.tomador_documento && s.tomador_documento === nota.tomador_documento);
    const exatas = doTomador.filter((s) => s.valor_centavos === nota.valor_centavos);
    const candidatas = exatas.length ? exatas : doTomador;
    return { lista, sugerida_id: candidatas.length === 1 ? candidatas[0].id : null };
  }

  function buscarSolicitacao(id, usuario) {
    const s = db.prepare(`
      SELECT s.*, e.razao_social AS empresa_nome, e.cnpj AS empresa_cnpj,
             u.nome AS criado_por_nome, r.nome AS responsavel_nome
      FROM solicitacoes s
      JOIN empresas e ON e.id = s.empresa_id
      JOIN usuarios u ON u.id = s.criado_por
      LEFT JOIN usuarios r ON r.id = s.responsavel_id
      WHERE s.id = ?
    `).get(id);
    if (!s || (usuario.papel === 'cliente' && s.empresa_id !== usuario.empresa_id)) {
      throw new ErroValidacao('Solicitação não encontrada.', 404);
    }
    return { ...s };
  }

  function filtrosSolicitacoes(usuario, query) {
    const condicoes = [];
    const params = [];
    if (usuario.papel === 'cliente') {
      condicoes.push('s.empresa_id = ?');
      params.push(usuario.empresa_id);
    } else if (query.get('empresa_id')) {
      condicoes.push('s.empresa_id = ?');
      params.push(Number(query.get('empresa_id')));
    }
    if (query.get('status')) {
      condicoes.push('s.status = ?');
      params.push(query.get('status'));
    }
    if (query.get('responsavel_id')) {
      condicoes.push('e.responsavel_id = ?');
      params.push(Number(query.get('responsavel_id')));
    }
    if (query.get('canal')) {
      condicoes.push('s.canal_pedido = ?');
      params.push(query.get('canal'));
    }
    const mes = query.get('mes');
    if (mes && /^\d{4}-\d{2}$/.test(mes)) {
      condicoes.push(`substr(${DATA_NOTA}, 1, 7) = ?`);
      params.push(mes);
    }
    // Período pela data da nota (mesma regra do relatório).
    for (const [param, operador] of [['inicio', '>='], ['fim', '<=']]) {
      const valor = query.get(param);
      if (valor && /^\d{4}-\d{2}-\d{2}$/.test(valor)) {
        condicoes.push(`${DATA_NOTA} ${operador} ?`);
        params.push(valor);
      }
    }
    const busca = query.get('busca');
    if (busca) {
      condicoes.push('(s.tomador_nome LIKE ? OR s.descricao LIKE ? OR s.numero_nota LIKE ? OR s.tomador_documento LIKE ?)');
      const termo = `%${busca}%`;
      params.push(termo, termo, termo, `%${apenasDigitos(busca) || busca}%`);
    }
    const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
    return { where, params };
  }

  function listarSolicitacoes(usuario, query) {
    const { where, params } = filtrosSolicitacoes(usuario, query);
    return db.prepare(`
      SELECT s.id, s.empresa_id, e.razao_social AS empresa_nome, s.tipo_nota, s.tomador_nome,
             s.tomador_documento, s.valor_centavos, s.data_competencia, s.status, s.numero_nota,
             s.data_emissao, s.canal_pedido, s.canal_outro, s.data_pedido, s.criado_em, s.atualizado_em,
             ${DATA_NOTA} AS data_nota,
             (SELECT COUNT(*) FROM anexos a WHERE a.solicitacao_id = s.id) AS anexos
      FROM solicitacoes s JOIN empresas e ON e.id = s.empresa_id
      ${where}
      ORDER BY CASE s.status WHEN 'pendente' THEN 0 WHEN 'em_emissao' THEN 1 ELSE 2 END, data_nota DESC, s.id DESC
      LIMIT 1000
    `).all(...params).map((linha) => ({ ...linha }));
  }

  // ---------- autenticação ----------

  rota('GET', '/api/saude', () => {
    db.prepare('SELECT 1').get();
    return { ok: true };
  }, { publica: true });

  rota('POST', '/api/login', ({ corpo, responder, ip }) => {
    const email = String(corpo.email ?? '').trim();
    const senha = String(corpo.senha ?? '');
    const minutos = limitador.bloqueio(ip, email);
    if (minutos) {
      throw new ErroValidacao(`Muitas tentativas de login. Tente novamente em ${minutos} minuto(s).`, 429);
    }
    const usuario = db.prepare('SELECT * FROM usuarios WHERE email = ? AND ativo = 1').get(email);
    if (!usuario || !auth.conferirSenha(senha, usuario.senha_hash)) {
      limitador.falhou(ip, email);
      throw new ErroValidacao('E-mail ou senha incorretos.', 401);
    }
    if (usuario.papel === 'cliente' && !acessoClientes) {
      throw new ErroValidacao('O acesso de clientes está desativado. Fale com o escritório.', 403);
    }
    limitador.acertou(ip, email);
    const token = auth.criarSessao(db, usuario.id);
    responder(200, { ok: true }, { 'Set-Cookie': auth.cookieSessao(token, { seguro: cookieSeguro }) });
  }, { publica: true });

  rota('POST', '/api/logout', ({ token, responder }) => {
    auth.encerrarSessao(db, token);
    responder(200, { ok: true }, { 'Set-Cookie': auth.cookieSessao('', { seguro: cookieSeguro }) });
  });

  rota('GET', '/api/opcoes', () => ({ canais: CANAIS_PEDIDO, acesso_clientes: acessoClientes }));

  rota('GET', '/api/me', ({ usuario }) => {
    const empresa = usuario.empresa_id
      ? db.prepare('SELECT id, razao_social, cnpj FROM empresas WHERE id = ?').get(usuario.empresa_id)
      : null;
    return { ...usuario, empresa: empresa ? { ...empresa } : null };
  });

  rota('POST', '/api/me/senha', ({ usuario, corpo }) => {
    const atual = db.prepare('SELECT senha_hash FROM usuarios WHERE id = ?').get(usuario.id);
    if (!auth.conferirSenha(String(corpo.senha_atual ?? ''), atual.senha_hash)) {
      throw new ErroValidacao('Senha atual incorreta.');
    }
    const nova = String(corpo.nova_senha ?? '');
    if (nova.length < 8) throw new ErroValidacao('A nova senha deve ter pelo menos 8 caracteres.');
    db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(auth.gerarHash(nova), usuario.id);
    return { ok: true };
  });

  // ---------- empresas (clientes do escritório) ----------

  rota('GET', '/api/empresas', () => db.prepare(`
    SELECT e.*, (SELECT nome FROM usuarios r WHERE r.id = e.responsavel_id) AS responsavel_nome,
      (SELECT COUNT(*) FROM solicitacoes s WHERE s.empresa_id = e.id AND s.status IN ('pendente','em_emissao')) AS abertas,
      (SELECT COUNT(*) FROM usuarios u WHERE u.empresa_id = e.id) AS usuarios
    FROM empresas e ORDER BY e.razao_social
  `).all().map((l) => ({ ...l })), { papel: 'escritorio' });

  function validarEmpresa(corpo) {
    const cnpj = apenasDigitos(corpo.cnpj);
    if (!cnpjValido(cnpj)) throw new ErroValidacao('CNPJ inválido.');
    const email = texto('E-mail', corpo.email, { max: 200 });
    if (email && !emailValido(email)) throw new ErroValidacao('E-mail inválido.');
    const planoNotas = corpo.plano_notas === true || corpo.plano_notas === 1 || corpo.plano_notas === '1' ? 1 : 0;
    let notasIncluidas = null;
    if (planoNotas && corpo.notas_incluidas !== undefined && corpo.notas_incluidas !== null && String(corpo.notas_incluidas).trim() !== '') {
      notasIncluidas = Number(corpo.notas_incluidas);
      if (!Number.isInteger(notasIncluidas) || notasIncluidas < 0) throw new ErroValidacao('Quantidade de notas incluídas inválida.');
    }
    let honorario = null;
    if (corpo.honorario !== undefined && corpo.honorario !== null && String(corpo.honorario).trim() !== '') {
      honorario = valorParaCentavos(corpo.honorario);
      if (!Number.isInteger(honorario) || honorario < 0) throw new ErroValidacao('Honorário mensal inválido.');
    }
    return {
      razao_social: texto('Razão social', corpo.razao_social, { obrigatorio: true, max: 200 }),
      cnpj,
      email,
      telefone: texto('Telefone', corpo.telefone, { max: 30 }),
      ativo: corpo.ativo === false || corpo.ativo === 0 ? 0 : 1,
      plano_notas: planoNotas,
      plano_nome: texto('Nome do plano', corpo.plano_nome, { max: 100 }),
      notas_incluidas: notasIncluidas,
      honorario_centavos: honorario,
      responsavel_id: validarResponsavel(corpo.responsavel_id),
    };
  }

  function validarResponsavel(valor) {
    if (valor === undefined || valor === null || valor === '') return null;
    const id = Number(valor);
    if (!db.prepare("SELECT 1 FROM usuarios WHERE id = ? AND papel = 'escritorio'").get(id)) {
      throw new ErroValidacao('Responsável inválido: escolha alguém da equipe do escritório.');
    }
    return id;
  }

  const CAMPOS_EMPRESA = ['razao_social', 'cnpj', 'email', 'telefone', 'ativo', 'plano_notas', 'plano_nome', 'notas_incluidas',
    'honorario_centavos', 'responsavel_id'];

  function erroUnico(err, mensagem) {
    if (String(err.message).includes('UNIQUE')) throw new ErroValidacao(mensagem, 409);
    throw err;
  }

  rota('POST', '/api/empresas', ({ corpo }) => {
    const e = validarEmpresa(corpo);
    try {
      const r = db.prepare(`INSERT INTO empresas (${CAMPOS_EMPRESA.join(', ')}) VALUES (${CAMPOS_EMPRESA.map(() => '?').join(', ')})`)
        .run(...CAMPOS_EMPRESA.map((c) => e[c]));
      return { id: Number(r.lastInsertRowid) };
    } catch (err) {
      return erroUnico(err, 'Já existe uma empresa com este CNPJ.');
    }
  }, { papel: 'escritorio' });

  // ---------- importação de empresas (planilha ou PDF) ----------

  rota('GET', '/api/empresas/modelo.csv', ({ responderBruto }) => {
    responderBruto(200, `\uFEFF${importacao.MODELO_CSV}`, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="modelo-empresas.csv"',
    });
  }, { papel: 'escritorio' });

  rota('POST', '/api/empresas/importar/analisar', async ({ corpo }) => {
    const nome = texto('Nome do arquivo', corpo.nome_arquivo, { obrigatorio: true, max: 200 });
    const conteudo = Buffer.from(String(corpo.conteudo_base64 ?? ''), 'base64');
    if (!conteudo.length) throw new ErroValidacao('Arquivo vazio.');
    if (conteudo.length > 10 * 1024 * 1024) throw new ErroValidacao('Arquivo maior que 10 MB.');
    const lido = await importacao.lerLinhas(nome, conteudo);
    const existentes = new Map(db.prepare('SELECT cnpj, razao_social FROM empresas').all().map((e) => [e.cnpj, e.razao_social]));
    const analise = importacao.analisarLinhas(lido, existentes);
    if (!analise.empresas.length) {
      throw new ErroValidacao('Não encontrei empresas neste arquivo. Confira se há uma coluna de CNPJ, ou use o modelo de planilha.', 422);
    }
    return analise;
  }, { papel: 'escritorio' });

  rota('POST', '/api/empresas/importar', ({ corpo }) => {
    if (!Array.isArray(corpo.empresas) || !corpo.empresas.length) throw new ErroValidacao('Selecione ao menos uma empresa.');
    if (corpo.empresas.length > 2000) throw new ErroValidacao('Importe no máximo 2.000 empresas por vez.');
    const atualizar = corpo.atualizar_existentes === true;
    const buscar = db.prepare('SELECT * FROM empresas WHERE cnpj = ?');
    const resumo = { criadas: 0, atualizadas: 0, ignoradas: 0, erros: [] };

    const operacoes = [];
    const vistos = new Set();
    for (const item of corpo.empresas) {
      try {
        const cnpj = apenasDigitos(item.cnpj);
        if (vistos.has(cnpj)) { resumo.ignoradas++; continue; }
        vistos.add(cnpj);
        const existente = buscar.get(cnpj);
        if (existente && !atualizar) { resumo.ignoradas++; continue; }
        // Em empresas já cadastradas, só sobrescreve o que veio preenchido no arquivo.
        const base = existente ? { ...existente, honorario: existente.honorario_centavos == null ? '' : existente.honorario_centavos / 100 } : {};
        const preenchido = (v) => v !== undefined && v !== null && v !== '';
        const dados = { ...base, ativo: existente ? existente.ativo : 1 };
        for (const campo of ['razao_social', 'email', 'telefone']) if (preenchido(item[campo])) dados[campo] = item[campo];
        dados.cnpj = cnpj;
        if (!existente || item.plano_informado) {
          dados.plano_notas = Boolean(item.plano_notas);
          if (preenchido(item.plano_nome)) dados.plano_nome = item.plano_nome;
          if (preenchido(item.notas_incluidas)) dados.notas_incluidas = item.notas_incluidas;
        }
        if (preenchido(item.honorario_centavos)) dados.honorario = Number(item.honorario_centavos) / 100;
        operacoes.push({ existente, empresa: validarEmpresa(dados) });
      } catch (err) {
        if (!(err instanceof ErroValidacao)) throw err;
        resumo.erros.push({ cnpj: item.cnpj, razao_social: item.razao_social, erro: err.message });
      }
    }

    transacao(db, () => {
      const inserir = db.prepare(`INSERT INTO empresas (${CAMPOS_EMPRESA.join(', ')}) VALUES (${CAMPOS_EMPRESA.map(() => '?').join(', ')})`);
      const atualizarSql = db.prepare(`UPDATE empresas SET ${CAMPOS_EMPRESA.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`);
      for (const { existente, empresa } of operacoes) {
        if (existente) {
          atualizarSql.run(...CAMPOS_EMPRESA.map((c) => empresa[c]), existente.id);
          resumo.atualizadas++;
        } else {
          inserir.run(...CAMPOS_EMPRESA.map((c) => empresa[c]));
          resumo.criadas++;
        }
      }
    });
    return resumo;
  }, { papel: 'escritorio' });

  function dependenciasEmpresa(id) {
    const conta = (sql) => db.prepare(sql).get(id).n;
    return {
      notas: conta('SELECT COUNT(*) AS n FROM solicitacoes WHERE empresa_id = ?'),
      ocorrencias: conta('SELECT COUNT(*) AS n FROM ocorrencias WHERE empresa_id = ?'),
      arquivos: conta('SELECT COUNT(*) AS n FROM anexos a JOIN solicitacoes s ON s.id = a.solicitacao_id WHERE s.empresa_id = ?')
        + conta('SELECT COUNT(*) AS n FROM ocorrencia_anexos a JOIN ocorrencias o ON o.id = a.ocorrencia_id WHERE o.empresa_id = ?'),
      usuarios: conta('SELECT COUNT(*) AS n FROM usuarios WHERE empresa_id = ?'),
    };
  }

  rota('GET', '/api/empresas/:id/dependencias', ({ params }) => {
    if (!db.prepare('SELECT 1 FROM empresas WHERE id = ?').get(params.id)) throw new ErroValidacao('Empresa não encontrada.', 404);
    return dependenciasEmpresa(params.id);
  }, { papel: 'escritorio' });

  // Apaga as empresas com tudo o que é delas (notas, histórico, ocorrências, anexos e acessos
  // de cliente) numa única transação; os arquivos saem do disco depois de gravado.
  function apagarEmpresas(ids) {
    const arquivos = [];
    transacao(db, () => {
      for (const id of ids) {
        arquivos.push(
          ...db.prepare('SELECT a.arquivo FROM anexos a JOIN solicitacoes s ON s.id = a.solicitacao_id WHERE s.empresa_id = ?').all(id),
          ...db.prepare('SELECT a.arquivo FROM ocorrencia_anexos a JOIN ocorrencias o ON o.id = a.ocorrencia_id WHERE o.empresa_id = ?').all(id),
        );
        db.prepare('DELETE FROM solicitacoes WHERE empresa_id = ?').run(id);
        db.prepare('DELETE FROM ocorrencias WHERE empresa_id = ?').run(id);
        db.prepare('DELETE FROM usuarios WHERE empresa_id = ?').run(id);
        db.prepare('DELETE FROM empresas WHERE id = ?').run(id);
      }
    });
    apagarArquivos(pastaArquivos, arquivos.map((a) => a.arquivo));
  }

  function somarDependencias(ids) {
    const total = { empresas: ids.length, notas: 0, ocorrencias: 0, arquivos: 0, usuarios: 0 };
    for (const id of ids) {
      const dep = dependenciasEmpresa(id);
      for (const chave of ['notas', 'ocorrencias', 'arquivos', 'usuarios']) total[chave] += dep[chave];
    }
    return total;
  }

  // Exclui uma empresa. Se houver registros vinculados, exige a confirmação "EXCLUIR".
  rota('DELETE', '/api/empresas/:id', ({ params, corpo }) => {
    const empresa = db.prepare('SELECT id FROM empresas WHERE id = ?').get(params.id);
    if (!empresa) throw new ErroValidacao('Empresa não encontrada.', 404);
    const dep = dependenciasEmpresa(empresa.id);
    if ((dep.notas || dep.ocorrencias || dep.usuarios) && corpo.confirmacao !== 'EXCLUIR') {
      throw new ErroValidacao('Esta empresa tem registros. Digite EXCLUIR para confirmar.', 409);
    }
    apagarEmpresas([empresa.id]);
    return { ok: true, ...dep };
  }, { papel: 'escritorio' });

  // Exclusão em lote (só administradores): sempre exige digitar "EXCLUIR".
  function idsDoLote(corpo) {
    if (!Array.isArray(corpo.ids) || !corpo.ids.length) throw new ErroValidacao('Selecione ao menos uma empresa.');
    if (corpo.ids.length > 1000) throw new ErroValidacao('Selecione no máximo 1.000 empresas por vez.');
    const ids = [...new Set(corpo.ids.map(Number))];
    const existentes = db.prepare(`SELECT id FROM empresas WHERE id IN (${ids.map(() => '?').join(', ')})`).all(...ids).map((e) => e.id);
    if (existentes.length !== ids.length) throw new ErroValidacao('Alguma empresa selecionada não existe mais. Atualize a página.', 409);
    return existentes;
  }

  rota('POST', '/api/empresas/excluir-lote/previa', ({ corpo }) => somarDependencias(idsDoLote(corpo)), { papel: 'escritorio', admin: true });

  rota('POST', '/api/empresas/excluir-lote', ({ corpo }) => {
    const ids = idsDoLote(corpo);
    if (corpo.confirmacao !== 'EXCLUIR') throw new ErroValidacao('Digite EXCLUIR para confirmar a exclusão em lote.', 409);
    const total = somarDependencias(ids);
    apagarEmpresas(ids);
    return { ok: true, ...total };
  }, { papel: 'escritorio', admin: true });

  rota('PUT', '/api/empresas/:id', ({ params, corpo }) => {
    const e = validarEmpresa(corpo);
    try {
      const r = db.prepare(`UPDATE empresas SET ${CAMPOS_EMPRESA.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
        .run(...CAMPOS_EMPRESA.map((c) => e[c]), params.id);
      if (!r.changes) throw new ErroValidacao('Empresa não encontrada.', 404);
      return { ok: true };
    } catch (err) {
      return erroUnico(err, 'Já existe uma empresa com este CNPJ.');
    }
  }, { papel: 'escritorio' });

  // ---------- usuários ----------

  rota('GET', '/api/usuarios', () => db.prepare(`
    SELECT u.id, u.nome, u.email, u.papel, u.empresa_id, u.ativo, u.admin, u.criado_em, e.razao_social AS empresa_nome
    FROM usuarios u LEFT JOIN empresas e ON e.id = u.empresa_id
    ORDER BY u.papel DESC, u.nome
  `).all().map((l) => ({ ...l })), { papel: 'escritorio' });

  rota('POST', '/api/usuarios', ({ corpo, usuario }) => {
    const nome = texto('Nome', corpo.nome, { obrigatorio: true, max: 200 });
    const email = texto('E-mail', corpo.email, { obrigatorio: true, max: 200 });
    if (!emailValido(email)) throw new ErroValidacao('E-mail inválido.');
    const papel = corpo.papel === 'cliente' ? 'cliente' : 'escritorio';
    if (papel === 'cliente' && !acessoClientes) throw new ErroValidacao('O acesso de clientes está desativado.');
    let empresaId = null;
    if (papel === 'cliente') {
      empresaId = Number(corpo.empresa_id);
      if (!db.prepare('SELECT 1 FROM empresas WHERE id = ?').get(empresaId)) {
        throw new ErroValidacao('Selecione a empresa do usuário cliente.');
      }
    }
    const senha = String(corpo.senha ?? '');
    if (senha.length < 8) throw new ErroValidacao('A senha deve ter pelo menos 8 caracteres.');
    try {
      // Só um administrador pode criar outro administrador.
      const admin = papel === 'escritorio' && usuario.admin && (corpo.admin === true || corpo.admin === '1') ? 1 : 0;
      const r = db.prepare('INSERT INTO usuarios (nome, email, senha_hash, papel, empresa_id, admin) VALUES (?, ?, ?, ?, ?, ?)')
        .run(nome, email, auth.gerarHash(senha), papel, empresaId, admin);
      return { id: Number(r.lastInsertRowid) };
    } catch (err) {
      return erroUnico(err, 'Já existe um usuário com este e-mail.');
    }
  }, { papel: 'escritorio' });

  rota('PUT', '/api/usuarios/:id', ({ params, corpo, usuario }) => {
    const alvo = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(params.id);
    if (!alvo) throw new ErroValidacao('Usuário não encontrado.', 404);
    const ativo = corpo.ativo === false || corpo.ativo === 0 ? 0 : 1;
    if (alvo.id === usuario.id && !ativo) throw new ErroValidacao('Você não pode desativar o próprio usuário.');
    const nome = texto('Nome', corpo.nome ?? alvo.nome, { obrigatorio: true, max: 200 });
    if (corpo.senha && String(corpo.senha).length < 8) {
      throw new ErroValidacao('A senha deve ter pelo menos 8 caracteres.');
    }
    let admin = alvo.admin;
    if (corpo.admin !== undefined && Boolean(corpo.admin) !== Boolean(alvo.admin)) {
      if (!usuario.admin) throw new ErroValidacao('Só um administrador pode alterar o perfil de administrador.', 403);
      if (alvo.papel !== 'escritorio') throw new ErroValidacao('Clientes não podem ser administradores.');
      if (alvo.id === usuario.id) throw new ErroValidacao('Você não pode remover o seu próprio perfil de administrador.');
      admin = corpo.admin ? 1 : 0;
    }
    if (alvo.admin && !ativo) {
      const outros = db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE admin = 1 AND ativo = 1 AND id <> ?").get(alvo.id).n;
      if (!outros) throw new ErroValidacao('Não é possível desativar o único administrador.');
    }
    db.prepare('UPDATE usuarios SET nome = ?, ativo = ?, admin = ? WHERE id = ?').run(nome, ativo, admin, alvo.id);
    if (corpo.senha) {
      db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(auth.gerarHash(String(corpo.senha)), alvo.id);
    }
    if (!ativo || corpo.senha) db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(alvo.id);
    return { ok: true };
  }, { papel: 'escritorio' });

  // ---------- solicitações ----------

  rota('GET', '/api/resumo', ({ usuario, query }) => {
    const { where, params } = filtrosSolicitacoes(usuario, query);
    const linhas = db.prepare(`
      SELECT s.status, COUNT(*) AS quantidade, SUM(s.valor_centavos) AS total_centavos
      FROM solicitacoes s JOIN empresas e ON e.id = s.empresa_id ${where} GROUP BY s.status
    `).all(...params);
    const resumo = {};
    for (const status of Object.keys(ROTULOS_STATUS)) resumo[status] = { quantidade: 0, total_centavos: 0 };
    for (const l of linhas) resumo[l.status] = { quantidade: l.quantidade, total_centavos: l.total_centavos ?? 0 };
    return resumo;
  });

  rota('GET', '/api/solicitacoes', ({ usuario, query }) => listarSolicitacoes(usuario, query));

  rota('GET', '/api/solicitacoes.csv', ({ usuario, query, responderBruto }) => {
    const linhas = listarSolicitacoes(usuario, query);
    const cabecalho = ['ID', 'Empresa', 'Nº nota', 'Emissão', 'Tipo', 'Tomador', 'CPF/CNPJ tomador', 'Valor',
      'Pedido recebido por', 'Data do pedido', 'Situação', 'Arquivos'];
    const csv = paraCsv([cabecalho, ...linhas.map((s) => [
      s.id, s.empresa_nome, s.numero_nota, s.data_nota, s.tipo_nota, s.tomador_nome, s.tomador_documento,
      s.valor_centavos == null ? '' : (s.valor_centavos / 100).toFixed(2).replace('.', ','),
      s.canal_pedido === 'outro' ? `Outro: ${s.canal_outro ?? ''}` : CANAIS_PEDIDO[s.canal_pedido] ?? '',
      s.data_pedido, ROTULOS_STATUS[s.status], s.anexos,
    ])]);
    responderBruto(200, csv, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="notas.csv"',
    });
  });

  rota('POST', '/api/solicitacoes', ({ usuario, corpo }) => {
    const dados = validarSolicitacao(corpo);
    let empresaId = usuario.empresa_id;
    if (usuario.papel === 'escritorio') {
      empresaId = Number(corpo.empresa_id);
    }
    const empresa = db.prepare('SELECT ativo FROM empresas WHERE id = ?').get(empresaId);
    if (!empresa) throw new ErroValidacao('Selecione a empresa emissora.');
    if (!empresa.ativo) throw new ErroValidacao('Esta empresa está inativa.');

    return transacao(db, () => {
      const r = db.prepare(`
        INSERT INTO solicitacoes (empresa_id, criado_por, tipo_nota, tomador_documento, tomador_nome, tomador_email,
          tomador_endereco, descricao, valor_centavos, data_competencia, observacoes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(empresaId, usuario.id, dados.tipo_nota, dados.tomador_documento, dados.tomador_nome, dados.tomador_email,
        dados.tomador_endereco, dados.descricao, dados.valor_centavos, dados.data_competencia, dados.observacoes);
      const id = Number(r.lastInsertRowid);
      registrarHistorico(id, usuario.id, 'criada', 'Solicitação criada.');
      return { id };
    });
  });

  rota('GET', '/api/solicitacoes/:id', ({ usuario, params }) => {
    const s = buscarSolicitacao(params.id, usuario);
    s.historico = db.prepare(`
      SELECT h.id, h.acao, h.mensagem, h.criado_em, u.nome AS usuario_nome, u.papel AS usuario_papel
      FROM historico h LEFT JOIN usuarios u ON u.id = h.usuario_id
      WHERE h.solicitacao_id = ? ORDER BY h.criado_em, h.id
    `).all(s.id).map((l) => ({ ...l }));
    s.anexos = db.prepare(`
      SELECT a.id, a.nome_arquivo, a.tipo_mime, a.tamanho, a.criado_em, u.nome AS enviado_por_nome
      FROM anexos a LEFT JOIN usuarios u ON u.id = a.enviado_por
      WHERE a.solicitacao_id = ? ORDER BY a.criado_em, a.id
    `).all(s.id).map((l) => ({ ...l }));
    s.transicoes = Object.entries(TRANSICOES[s.status])
      .filter(([, papeis]) => papeis.includes(usuario.papel))
      .map(([destino]) => destino);
    s.editavel = ['pendente', 'rejeitada'].includes(s.status);
    return s;
  });

  rota('PUT', '/api/solicitacoes/:id', ({ usuario, params, corpo }) => {
    const s = buscarSolicitacao(params.id, usuario);
    if (!['pendente', 'rejeitada'].includes(s.status)) {
      throw new ErroValidacao('Só é possível editar solicitações pendentes ou rejeitadas.', 409);
    }
    const d = validarSolicitacao(corpo);
    transacao(db, () => {
      db.prepare(`
        UPDATE solicitacoes SET tipo_nota = ?, tomador_documento = ?, tomador_nome = ?, tomador_email = ?,
          tomador_endereco = ?, descricao = ?, valor_centavos = ?, data_competencia = ?, observacoes = ?,
          status = 'pendente', motivo_rejeicao = NULL, atualizado_em = datetime('now')
        WHERE id = ?
      `).run(d.tipo_nota, d.tomador_documento, d.tomador_nome, d.tomador_email, d.tomador_endereco,
        d.descricao, d.valor_centavos, d.data_competencia, d.observacoes, s.id);
      registrarHistorico(s.id, usuario.id, 'editada',
        s.status === 'rejeitada' ? 'Solicitação corrigida e reenviada.' : 'Dados da solicitação alterados.');
    });
    return { ok: true };
  });

  rota('POST', '/api/solicitacoes/:id/status', ({ usuario, params, corpo }) => {
    const s = buscarSolicitacao(params.id, usuario);
    const destino = String(corpo.status ?? '');
    const permitidos = TRANSICOES[s.status][destino];
    if (!permitidos) {
      throw new ErroValidacao(`Não é possível mudar de "${ROTULOS_STATUS[s.status]}" para "${ROTULOS_STATUS[destino] ?? destino}".`, 409);
    }
    if (!permitidos.includes(usuario.papel)) throw new ErroValidacao('Você não tem permissão para esta ação.', 403);

    const mensagem = texto('Mensagem', corpo.mensagem, { max: 2000 });
    const campos = { status: destino };
    if (destino === 'emitida') {
      campos.numero_nota = texto('Número da nota', corpo.numero_nota, { obrigatorio: true, max: 50 });
      verificarNotaDuplicada(s.empresa_id, campos.numero_nota, s.id);
      campos.data_emissao = hojeBrasilia();
    }
    if (destino === 'rejeitada') {
      campos.motivo_rejeicao = texto('Motivo da rejeição', corpo.mensagem, { obrigatorio: true, max: 2000 });
    }
    if (destino === 'em_emissao') campos.responsavel_id = usuario.id;
    if (destino === 'cancelada' && usuario.papel === 'cliente' && !mensagem) {
      throw new ErroValidacao('Informe o motivo do cancelamento.');
    }

    transacao(db, () => {
      const sets = Object.keys(campos).map((c) => `${c} = ?`).join(', ');
      db.prepare(`UPDATE solicitacoes SET ${sets}, atualizado_em = datetime('now') WHERE id = ?`)
        .run(...Object.values(campos), s.id);
      const detalhe = destino === 'emitida' ? `Nota nº ${campos.numero_nota} emitida.` : null;
      registrarHistorico(s.id, usuario.id, `status:${destino}`, [detalhe, mensagem].filter(Boolean).join(' ') || null);
    });
    return { ok: true };
  });

  rota('POST', '/api/solicitacoes/:id/comentarios', ({ usuario, params, corpo }) => {
    const s = buscarSolicitacao(params.id, usuario);
    const mensagem = texto('Comentário', corpo.mensagem, { obrigatorio: true, max: 2000 });
    registrarHistorico(s.id, usuario.id, 'comentario', mensagem);
    db.prepare("UPDATE solicitacoes SET atualizado_em = datetime('now') WHERE id = ?").run(s.id);
    return { ok: true };
  });

  rota('POST', '/api/solicitacoes/:id/anexos', ({ usuario, params, corpo }) => {
    const s = buscarSolicitacao(params.id, usuario);
    if (s.status === 'cancelada') throw new ErroValidacao('Solicitação cancelada não aceita anexos.', 409);
    const { gravados, desfazer } = gravarArquivos(pastaArquivos, [prepararArquivo(corpo)]);
    try {
      const [id] = transacao(db, () => inserirAnexos(s.id, gravados, usuario.id));
      return { id };
    } catch (err) {
      desfazer();
      throw err;
    }
  });

  rota('GET', '/api/anexos/:id', ({ usuario, params, responderBruto }) => {
    const a = db.prepare('SELECT * FROM anexos WHERE id = ?').get(params.id);
    if (!a) throw new ErroValidacao('Anexo não encontrado.', 404);
    buscarSolicitacao(a.solicitacao_id, usuario); // garante que o usuário pode ver a solicitação
    responderBruto(200, lerArquivo(pastaArquivos, a.arquivo), cabecalhosDownload(a));
  });

  // ---------- registro de nota já emitida (perfil do cliente) ----------

  rota('POST', '/api/notas/ler-xml', ({ corpo }) => {
    const xml = Buffer.from(String(corpo.conteudo_base64 ?? ''), 'base64').toString('utf8');
    const dados = lerXmlNota(xml);
    if (!dados) throw new ErroValidacao('Não reconheci este XML como NF-e ou NFS-e. Preencha os dados manualmente.', 422);

    const avisos = [];
    const pelaNota = dados.emitente_documento
      ? db.prepare('SELECT id, razao_social FROM empresas WHERE cnpj = ?').get(dados.emitente_documento)
      : null;
    let empresaId = corpo.empresa_id ? Number(corpo.empresa_id) : null;
    if (empresaId && pelaNota && pelaNota.id !== empresaId) {
      avisos.push(`Este XML foi emitido por ${pelaNota.razao_social}, não por esta empresa. Confira antes de salvar.`);
    } else if (empresaId && dados.emitente_documento && !pelaNota) {
      avisos.push(`O emitente do XML (CNPJ ${dados.emitente_documento}) não é desta empresa. Confira antes de salvar.`);
    } else if (!empresaId && pelaNota) {
      empresaId = pelaNota.id;
    } else if (!empresaId) {
      avisos.push('Nenhuma empresa cadastrada com o CNPJ do emitente deste XML. Selecione a empresa.');
    }
    if (empresaId && dados.numero) {
      const existente = db.prepare("SELECT id FROM solicitacoes WHERE empresa_id = ? AND numero_nota = ? AND status <> 'cancelada'")
        .get(empresaId, dados.numero);
      if (existente) avisos.push(`A nota nº ${dados.numero} já está registrada (solicitação #${existente.id}).`);
    }
    const abertas = empresaId ? solicitacoesAbertas(empresaId, dados) : { lista: [], sugerida_id: null };
    return { dados, empresa_id: empresaId, avisos, abertas: abertas.lista, sugerida_id: abertas.sugerida_id };
  }, { papel: 'escritorio' });

  rota('GET', '/api/empresas/:id/solicitacoes-abertas', ({ params }) => solicitacoesAbertas(params.id, {}).lista,
    { papel: 'escritorio' });

  // Nota emitida registrada pelo escritório (pedido recebido por WhatsApp, e-mail etc.).
  // Pode atender uma solicitação aberta (quando o acesso de clientes está ligado) ou ser nova.
  rota('POST', '/api/notas-emitidas', ({ corpo, usuario }) => {
    const empresa = db.prepare('SELECT id FROM empresas WHERE id = ?').get(Number(corpo.empresa_id));
    if (!empresa) throw new ErroValidacao('Selecione a empresa.');
    const nota = validarNota(corpo);
    const preparados = prepararArquivos(corpo.arquivos);

    let vinculada = null;
    if (corpo.solicitacao_id) {
      vinculada = db.prepare('SELECT * FROM solicitacoes WHERE id = ? AND empresa_id = ?').get(Number(corpo.solicitacao_id), empresa.id);
      if (!vinculada) throw new ErroValidacao('Solicitação não encontrada para esta empresa.', 404);
      if (!['pendente', 'em_emissao'].includes(vinculada.status)) {
        throw new ErroValidacao(`A solicitação #${vinculada.id} não está aberta.`, 409);
      }
    }
    verificarNotaDuplicada(empresa.id, nota.numero_nota, vinculada?.id ?? null);

    const { gravados, desfazer } = gravarArquivos(pastaArquivos, preparados);
    try {
      const id = transacao(db, () => {
        let solicitacaoId;
        if (vinculada) {
          solicitacaoId = vinculada.id;
          db.prepare(`
            UPDATE solicitacoes SET status = 'emitida', numero_nota = ?, data_emissao = ?,
              canal_pedido = COALESCE(?, canal_pedido), canal_outro = COALESCE(?, canal_outro),
              responsavel_id = COALESCE(responsavel_id, ?), atualizado_em = datetime('now')
            WHERE id = ?
          `).run(nota.numero_nota, nota.data_emissao, nota.canal_pedido, nota.canal_outro, usuario.id, solicitacaoId);
          const diferenca = nota.valor_centavos && vinculada.valor_centavos && nota.valor_centavos !== vinculada.valor_centavos
            ? ` Atenção: valor da nota (${reaisTexto(nota.valor_centavos)}) diferente do solicitado (${reaisTexto(vinculada.valor_centavos)}).`
            : '';
          registrarHistorico(solicitacaoId, usuario.id, 'status:emitida', `Nota nº ${nota.numero_nota} emitida.${diferenca}`);
        } else {
          const r = db.prepare(`
            INSERT INTO solicitacoes (empresa_id, criado_por, tipo_nota, tomador_documento, tomador_nome, tomador_email,
              descricao, valor_centavos, data_competencia, status, numero_nota, data_emissao, responsavel_id,
              canal_pedido, canal_outro, data_pedido)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'emitida', ?, ?, ?, ?, ?, ?)
          `).run(empresa.id, usuario.id, nota.tipo_nota, nota.tomador_documento, nota.tomador_nome, nota.tomador_email,
            nota.descricao, nota.valor_centavos, nota.data_emissao, nota.numero_nota, nota.data_emissao, usuario.id,
            nota.canal_pedido, nota.canal_outro, nota.data_pedido);
          solicitacaoId = Number(r.lastInsertRowid);
          const canal = nota.canal_pedido ? ` Pedido recebido por ${nota.canal_outro ?? CANAIS_PEDIDO[nota.canal_pedido]}.` : '';
          registrarHistorico(solicitacaoId, usuario.id, 'status:emitida', `Nota nº ${nota.numero_nota} registrada.${canal}`);
        }
        inserirAnexos(solicitacaoId, gravados, usuario.id);
        return solicitacaoId;
      });
      return { id, vinculada: Boolean(vinculada) };
    } catch (err) {
      desfazer();
      throw err;
    }
  }, { papel: 'escritorio' });

  rota('PUT', '/api/notas-emitidas/:id', ({ corpo, params, usuario }) => {
    const atual = db.prepare("SELECT * FROM solicitacoes WHERE id = ? AND status = 'emitida'").get(params.id);
    if (!atual) throw new ErroValidacao('Nota não encontrada.', 404);
    const nota = validarNota(corpo);
    verificarNotaDuplicada(atual.empresa_id, nota.numero_nota, atual.id);
    transacao(db, () => {
      db.prepare(`
        UPDATE solicitacoes SET numero_nota = ?, data_emissao = ?, tipo_nota = ?, tomador_documento = ?, tomador_nome = ?,
          tomador_email = ?, descricao = ?, valor_centavos = ?, canal_pedido = ?, canal_outro = ?, data_pedido = ?,
          atualizado_em = datetime('now')
        WHERE id = ?
      `).run(nota.numero_nota, nota.data_emissao, nota.tipo_nota, nota.tomador_documento, nota.tomador_nome,
        nota.tomador_email, nota.descricao, nota.valor_centavos, nota.canal_pedido, nota.canal_outro, nota.data_pedido, atual.id);
      registrarHistorico(atual.id, usuario.id, 'editada', 'Dados da nota alterados.');
    });
    return { ok: true };
  }, { papel: 'escritorio' });

  rota('DELETE', '/api/solicitacoes/:id', ({ params }) => {
    const arquivos = db.prepare('SELECT arquivo FROM anexos WHERE solicitacao_id = ?').all(params.id);
    const r = db.prepare('DELETE FROM solicitacoes WHERE id = ?').run(params.id);
    if (!r.changes) throw new ErroValidacao('Nota não encontrada.', 404);
    apagarArquivos(pastaArquivos, arquivos.map((a) => a.arquivo));
    return { ok: true };
  }, { papel: 'escritorio' });

  // ---------- controle operacional (ocorrências e relatório) ----------

  registrarRotasOperacionais({ rota, db, pastaArquivos });

  // ---------- servidor HTTP ----------

  function servirEstatico(req, res, caminho) {
    const relativo = caminho === '/' ? 'index.html' : caminho.slice(1);
    const completo = path.normalize(path.join(PASTA_PUBLICA, relativo));
    if (!completo.startsWith(PASTA_PUBLICA + path.sep) || !fs.existsSync(completo) || !fs.statSync(completo).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Não encontrado');
    }
    res.writeHead(200, {
      'Content-Type': MIME_ESTATICO[path.extname(completo)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(completo).pipe(res);
  }

  function lerCorpo(req) {
    return new Promise((resolve, reject) => {
      const partes = [];
      let tamanho = 0;
      req.on('data', (parte) => {
        tamanho += parte.length;
        if (tamanho > LIMITE_CORPO) {
          reject(new ErroValidacao('Requisição muito grande.', 413));
          req.destroy();
          return;
        }
        partes.push(parte);
      });
      req.on('end', () => {
        if (!partes.length) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(partes).toString('utf8')));
        } catch {
          reject(new ErroValidacao('JSON inválido.'));
        }
      });
      req.on('error', reject);
    });
  }

  return async function tratarRequisicao(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const cabecalhosSeguranca = {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'",
    };
    for (const [k, v] of Object.entries(cabecalhosSeguranca)) res.setHeader(k, v);

    const responderBruto = (status, corpo, cabecalhos = {}) => {
      res.writeHead(status, cabecalhos);
      res.end(corpo);
    };
    const responder = (status, dados, cabecalhos = {}) => responderBruto(
      status, JSON.stringify(dados), { 'Content-Type': 'application/json; charset=utf-8', ...cabecalhos },
    );

    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') return responder(405, { erro: 'Método não permitido.' });
      return servirEstatico(req, res, url.pathname);
    }

    try {
      let params = null;
      const r = rotas.find((x) => {
        if (x.metodo !== req.method) return false;
        const m = x.regex.exec(url.pathname);
        if (m) params = Object.fromEntries(Object.entries(m.groups ?? {}).map(([k, v]) => [k, Number(v)]));
        return Boolean(m);
      });
      if (!r) throw new ErroValidacao('Rota não encontrada.', 404);

      const token = auth.lerCookies(req.headers.cookie)[auth.NOME_COOKIE];
      let usuario = auth.usuarioDaSessao(db, token);
      if (usuario?.papel === 'cliente' && !acessoClientes) usuario = null;
      if (!r.publica && !usuario) throw new ErroValidacao('Faça login para continuar.', 401);
      if (r.papel && usuario.papel !== r.papel) throw new ErroValidacao('Acesso restrito ao escritório.', 403);
      if (r.admin && !usuario.admin) throw new ErroValidacao('Ação permitida só para administradores.', 403);

      // Proteção contra CSRF: requisições que alteram dados precisam vir como JSON.
      if (req.method !== 'GET' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
        throw new ErroValidacao('Envie os dados como application/json.', 415);
      }
      const corpo = req.method === 'GET' ? {} : await lerCorpo(req);

      // Atrás de um proxy (Caddy), o IP real é o último do X-Forwarded-For (o que o proxy
      // acrescentou); os anteriores vêm do visitante e podem ser forjados.
      const ip = (confiarProxy && String(req.headers['x-forwarded-for'] ?? '').split(',').pop().trim())
        || req.socket.remoteAddress;

      let enviado = false;
      const ctx = {
        usuario, token, params, corpo, ip, query: url.searchParams,
        responder: (...a) => { enviado = true; responder(...a); },
        responderBruto: (...a) => { enviado = true; responderBruto(...a); },
      };
      const resultado = await r.handler(ctx);
      if (!enviado) responder(200, resultado ?? { ok: true });
    } catch (err) {
      if (err instanceof ErroValidacao) {
        responder(err.status, { erro: err.message });
      } else {
        console.error(err);
        responder(500, { erro: 'Erro interno no servidor.' });
      }
    }
  };
}

module.exports = { criarApp, TRANSICOES, ROTULOS_STATUS };
