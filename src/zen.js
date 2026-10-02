'use strict';

// Integração com o Questor Zen: recebe pelo webhook os documentos postados no Zen para os
// clientes e os mostra no portal do cliente. O formato exato que o Zen envia (JSON, formulário
// ou multipart; arquivo em base64, link ou anexo) não é detalhado na documentação, então a
// leitura aceita todas essas formas e guarda o que chegou para conferência.

const crypto = require('node:crypto');
const { transacao } = require('./db');
const { gravarArquivos, apagarArquivos, lerArquivo, cabecalhosDownload } = require('./arquivos');
const { ErroValidacao } = require('./validacao');

const LIMITE_ARQUIVO = 25 * 1024 * 1024;
const LIMITE_PAYLOAD_GUARDADO = 50000;

// ---------- leitura do corpo ----------

function lerMultipart(corpo, tipoConteudo) {
  const limite = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(tipoConteudo);
  if (!limite) return null;
  const separador = Buffer.from(`--${limite[1] ?? limite[2].trim()}`);
  const campos = {};
  const arquivos = [];
  let inicio = corpo.indexOf(separador);
  while (inicio !== -1) {
    const proximo = corpo.indexOf(separador, inicio + separador.length);
    if (proximo === -1) break;
    // Cada parte: "\r\n" + cabeçalhos + "\r\n\r\n" + conteúdo + "\r\n"
    const parte = corpo.subarray(inicio + separador.length + 2, proximo - 2);
    const fimCabecalho = parte.indexOf('\r\n\r\n');
    if (fimCabecalho !== -1) {
      const cabecalhos = parte.subarray(0, fimCabecalho).toString('utf8');
      const conteudo = parte.subarray(fimCabecalho + 4);
      const nome = /name="([^"]*)"/i.exec(cabecalhos)?.[1] ?? '';
      const nomeArquivo = /filename\*?=(?:UTF-8'')?"?([^";\r\n]*)"?/i.exec(cabecalhos)?.[1];
      if (nomeArquivo !== undefined) {
        arquivos.push({ campo: nome, nome: decodeURIComponent(nomeArquivo), conteudo });
      } else {
        campos[nome] = conteudo.toString('utf8');
      }
    }
    inicio = proximo;
  }
  return { campos, arquivos };
}

const tentarJson = (texto) => {
  try {
    return JSON.parse(texto);
  } catch {
    return undefined;
  }
};

// Junta campos de formulário num objeto; um campo que contém JSON é desdobrado.
function camposParaDados(campos) {
  const dados = {};
  for (const [nome, valor] of Object.entries(campos)) {
    const json = tentarJson(valor);
    if (json && typeof json === 'object' && !Array.isArray(json) && !nome.match(/^atributos?$|^destinatarios$/i)) Object.assign(dados, json);
    else dados[nome] = json !== undefined && typeof json === 'object' ? json : valor;
  }
  return dados;
}

// Devolve { documentos: [dados...], arquivoMultipart, formato } ou documentos vazio quando não reconhece.
function interpretarCorpo(corpo, tipoConteudo = '') {
  if (/multipart\/form-data/i.test(tipoConteudo)) {
    const mp = lerMultipart(corpo, tipoConteudo);
    if (mp) return { documentos: [camposParaDados(mp.campos)], arquivoMultipart: mp.arquivos[0], formato: 'multipart' };
  }
  const texto = corpo.toString('utf8').replace(/^﻿/, '').trim();
  const json = tentarJson(texto);
  if (json && typeof json === 'object') {
    const lista = (Array.isArray(json) ? json : [json]).filter((d) => d && typeof d === 'object');
    return { documentos: lista, formato: 'json' };
  }
  if (texto.includes('=')) {
    const campos = Object.fromEntries(new URLSearchParams(texto));
    if (Object.keys(campos).length) return { documentos: [camposParaDados(campos)], formato: 'formulario' };
  }
  return { documentos: [], formato: 'desconhecido' };
}

// ---------- interpretação dos campos ----------

const chaveSimples = (k) => String(k).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();

// Busca um campo ignorando maiúsculas, acentos e espaços.
function obter(obj, ...nomes) {
  if (!obj || typeof obj !== 'object') return undefined;
  const alvo = new Set(nomes.map(chaveSimples));
  for (const [k, v] of Object.entries(obj)) if (alvo.has(chaveSimples(k))) return v;
  return undefined;
}

const textoOuNulo = (v, max = 500) => {
  if (v == null || typeof v === 'object') return null;
  const t = String(v).trim();
  return t ? t.slice(0, max) : null;
};

function dataIso(valor) {
  const t = String(valor ?? '').trim();
  let m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(t);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function competenciaIso(valor) {
  const t = String(valor ?? '').trim();
  let m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(t);
  if (m) return `${m[3]}-${m[2]}`;
  m = /^(\d{2})\/(\d{4})$/.exec(t);
  if (m) return `${m[2]}-${m[1]}`;
  m = /^(\d{4})-?(\d{2})/.exec(t);
  return m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${m[1]}-${m[2]}` : null;
}

function valorCentavos(valor) {
  let t = String(valor ?? '').replace(/[^\d,.-]/g, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

// Atributos chegam como lista [{Nome, Valor}] (webhook) ou objeto { DataVencimento, ... }.
function lerAtributos(bruto) {
  let attrs = typeof bruto === 'string' ? tentarJson(bruto) : bruto;
  const mapa = {};
  if (Array.isArray(attrs)) {
    for (const a of attrs) {
      const nome = obter(a, 'Nome', 'Name');
      if (nome != null) mapa[chaveSimples(nome)] = obter(a, 'Valor', 'Value');
    }
  } else if (attrs && typeof attrs === 'object') {
    for (const [k, v] of Object.entries(attrs)) mapa[chaveSimples(k)] = v;
  }
  const pegar = (...nomes) => nomes.map(chaveSimples).map((n) => mapa[n]).find((v) => v != null && v !== '');
  const mes = pegar('MonthCompetence', 'MesCompetencia');
  const ano = pegar('YearCompetence', 'AnoCompetencia');
  return {
    vencimento: dataIso(pegar('DateExpire', 'DataVencimento', 'Data de Vencimento', 'Vencimento')),
    competencia: mes && ano ? competenciaIso(`${ano}-${String(mes).padStart(2, '0')}`)
      : competenciaIso(pegar('DataCompetencia', 'Data de Competência', 'Competencia')),
    valor_centavos: valorCentavos(pegar('Value', 'Valor')),
  };
}

// Destinatários: lista [{ClienteNome, Usuarios: [{UsuarioNome, UsuarioEmail}]}], objeto ou texto.
function lerDestinatarios(bruto) {
  const valor = typeof bruto === 'string' ? (tentarJson(bruto) ?? bruto) : bruto;
  const nomes = [];
  const emails = [];
  const visitar = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) return v.forEach(visitar);
    if (typeof v === 'object') {
      const nome = textoOuNulo(obter(v, 'ClienteNome', 'Cliente', 'NomeCliente'), 300);
      if (nome) nomes.push(nome);
      const email = textoOuNulo(obter(v, 'UsuarioEmail', 'Email'), 200);
      if (email) emails.push(email.toLowerCase());
      visitar(obter(v, 'Usuarios', 'UsuarioDestino'));
      return;
    }
    const t = String(v).trim();
    if (/^[^\s@]+@[^\s@]+$/.test(t)) emails.push(t.toLowerCase());
    else if (t) nomes.push(t.slice(0, 300));
  };
  visitar(valor);
  return { nomes: [...new Set(nomes)], emails: [...new Set(emails)] };
}

const TIPOS = [
  { teste: (b) => b.subarray(0, 4).toString('latin1') === '%PDF', tipo: 'application/pdf', extensao: '.pdf' },
  { teste: (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), tipo: 'image/png', extensao: '.png' },
  { teste: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, tipo: 'image/jpeg', extensao: '.jpg' },
  { teste: (b) => b.subarray(0, 2).toString('latin1') === 'PK', tipo: 'application/zip', extensao: '.zip' },
  { teste: (b) => /^\s*</.test(b.subarray(0, 64).toString('utf8').replace(/^﻿/, '')), tipo: 'application/xml', extensao: '.xml' },
];

// Converte o campo Arquivo no conteúdo do arquivo; quando não dá, explica o que veio.
function lerArquivoRecebido(bruto, arquivoMultipart, titulo) {
  let conteudo = null;
  let nome = null;
  let info = null;
  if (arquivoMultipart?.conteudo?.length) {
    conteudo = arquivoMultipart.conteudo;
    nome = arquivoMultipart.nome;
  } else if (Array.isArray(bruto) && bruto.length && bruto.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) {
    conteudo = Buffer.from(bruto);
  } else if (bruto && typeof bruto === 'object') {
    nome = textoOuNulo(obter(bruto, 'Nome', 'NomeArquivo', 'FileName', 'Name'), 200);
    const interno = obter(bruto, 'Conteudo', 'Base64', 'Content', 'Data', 'Bytes', 'Arquivo', 'File');
    return { ...lerArquivoRecebido(interno, null, titulo), ...(nome ? { nome } : {}) };
  } else if (typeof bruto === 'string' && bruto.trim()) {
    const t = bruto.trim();
    if (/^https?:\/\//i.test(t)) {
      info = `Link recebido: ${t.slice(0, 1000)}`;
    } else {
      const base64 = t.replace(/^data:[^,]*;base64,/i, '').replace(/\s/g, '');
      if (/^[A-Za-z0-9+/_-]+=*$/.test(base64) && base64.length >= 8) conteudo = Buffer.from(base64, 'base64');
      else info = `Texto recebido no campo Arquivo (${t.length} caracteres), não reconhecido como arquivo.`;
    }
  } else {
    info = 'O Zen não enviou o arquivo (campo Arquivo vazio).';
  }
  if (!conteudo) return { info };
  if (conteudo.length > LIMITE_ARQUIVO) return { info: `Arquivo maior que 25 MB (${conteudo.length} bytes); não foi guardado.` };
  const tipo = TIPOS.find((t) => t.teste(conteudo));
  if (!tipo) return { info: `Arquivo recebido (${conteudo.length} bytes), mas o formato não foi reconhecido.` };
  const base = String(nome || titulo || 'documento').replace(/[\\/\0\r\n"]/g, '_').slice(0, 150);
  const nomeFinal = base.toLowerCase().endsWith(tipo.extensao) ? base : `${base.replace(/\.[a-z0-9]{2,4}$/i, '')}${tipo.extensao}`;
  return { arquivo: { nome: nomeFinal, tipo_mime: tipo.tipo, extensao: tipo.extensao, conteudo } };
}

// Versão do documento para guardar e mostrar ao escritório (sem o conteúdo binário).
function resumirPayload(dados) {
  return JSON.stringify(dados, (k, v) => {
    if (typeof v === 'string' && v.length > 300 && /^arquivo$|^file$|conteudo|base64/i.test(chaveSimples(k))) return `[${v.length} caracteres omitidos]`;
    if (Array.isArray(v) && v.length > 300 && v.every((n) => typeof n === 'number')) return `[${v.length} bytes omitidos]`;
    return v;
  }, 2).slice(0, LIMITE_PAYLOAD_GUARDADO);
}

// Nome da empresa sem acentos, pontuação e sufixos societários, para comparar com o Zen.
function normalizarNome(nome) {
  return String(nome ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/\bS\s*[./]\s*A\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .split(' ')
    .filter((p) => p && !['LTDA', 'ME', 'EPP', 'EIRELI', 'SLU', 'MEI', 'SS', 'SA', 'MATRIZ', 'FILIAL'].includes(p))
    .join(' ');
}

// ---------- rotas ----------

function registrarRotasZen({ rota, db, pastaArquivos, tokenWebhook }) {
  // Descobre a empresa do documento: e-mail de usuário cliente, CNPJ no nome, nome igual ao
  // cadastro ou um documento anterior do mesmo cliente que a equipe já associou.
  function associar({ nomes, emails }) {
    for (const email of emails) {
      const u = db.prepare("SELECT empresa_id FROM usuarios WHERE papel = 'cliente' AND email = ? AND empresa_id IS NOT NULL").get(email);
      if (u) return { empresa_id: u.empresa_id, associacao: 'email' };
    }
    const empresas = db.prepare('SELECT id, razao_social, cnpj FROM empresas').all();
    for (const nome of nomes) {
      const cnpj = /\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/.exec(nome)?.[0].replace(/\D/g, '');
      const porCnpj = cnpj && empresas.find((e) => e.cnpj === cnpj);
      if (porCnpj) return { empresa_id: porCnpj.id, associacao: 'cnpj' };
      const alvo = normalizarNome(nome);
      const iguais = alvo ? empresas.filter((e) => normalizarNome(e.razao_social) === alvo) : [];
      if (iguais.length === 1) return { empresa_id: iguais[0].id, associacao: 'nome' };
    }
    for (const nome of nomes) {
      const anterior = db.prepare(`
        SELECT empresa_id FROM zen_documentos WHERE cliente_nome = ? AND associacao = 'manual' AND empresa_id IS NOT NULL
        ORDER BY id DESC LIMIT 1
      `).get(nome);
      if (anterior) return { empresa_id: anterior.empresa_id, associacao: 'anterior' };
    }
    return { empresa_id: null, associacao: null };
  }

  function gravarDocumento(dados, { arquivoMultipart, tipoConteudo }) {
    const titulo = textoOuNulo(obter(dados, 'Titulo', 'Title'), 300);
    const zenId = textoOuNulo(obter(dados, 'Id', 'IdDocumento', 'CodigoDocumento'), 100);
    const destinatarios = lerDestinatarios(obter(dados, 'Destinatarios', 'UsuarioDestino'));
    const clienteDireto = textoOuNulo(obter(dados, 'ClienteNome', 'Cliente'), 300);
    if (clienteDireto) destinatarios.nomes.unshift(clienteDireto);
    const atributos = lerAtributos(obter(dados, 'Atributos', 'Atributo'));
    const recebido = lerArquivoRecebido(obter(dados, 'Arquivo', 'File'), arquivoMultipart, titulo);
    const { gravados, desfazer } = gravarArquivos(pastaArquivos, recebido.arquivo ? [recebido.arquivo] : []);
    const g = gravados[0];

    try {
      return transacao(db, () => {
        const anterior = zenId ? db.prepare('SELECT id, arquivo, empresa_id, associacao FROM zen_documentos WHERE zen_id = ?').get(zenId) : null;
        let assoc = associar(destinatarios);
        // Reenvio do mesmo documento: mantém a associação feita pela equipe se a automática falhar.
        if (anterior && !assoc.empresa_id && anterior.empresa_id) assoc = { empresa_id: anterior.empresa_id, associacao: anterior.associacao };
        const valores = {
          zen_id: zenId,
          empresa_id: assoc.empresa_id,
          associacao: assoc.associacao,
          titulo,
          categoria: textoOuNulo(obter(dados, 'CategoriaDescricao', 'Categoria'), 200),
          categoria_id: textoOuNulo(obter(dados, 'CategoriaId', 'CodigoCategoria'), 100),
          status: textoOuNulo(obter(dados, 'Status'), 50),
          observacao: textoOuNulo(obter(dados, 'Observacao'), 2000),
          cliente_nome: destinatarios.nomes[0] ?? null,
          destinatarios_emails: destinatarios.emails.join(', ') || null,
          data_criacao: textoOuNulo(obter(dados, 'DataCriacao'), 50),
          vencimento: atributos.vencimento,
          competencia: atributos.competencia,
          valor_centavos: atributos.valor_centavos,
          nome_arquivo: g?.nome ?? null,
          arquivo: g?.arquivo ?? null,
          tipo_mime: g?.tipo_mime ?? null,
          tamanho: g?.tamanho ?? null,
          arquivo_info: recebido.info ?? null,
          tipo_conteudo: String(tipoConteudo ?? '').slice(0, 200) || null,
          payload: resumirPayload(dados),
        };
        const colunas = Object.keys(valores);
        if (anterior) {
          // Sem arquivo novo, fica o que já havia.
          if (!g) for (const c of ['nome_arquivo', 'arquivo', 'tipo_mime', 'tamanho']) delete valores[c];
          const sets = Object.keys(valores).map((c) => `${c} = ?`).join(', ');
          db.prepare(`UPDATE zen_documentos SET ${sets}, recebido_em = datetime('now') WHERE id = ?`).run(...Object.values(valores), anterior.id);
          if (g && anterior.arquivo) apagarArquivos(pastaArquivos, [anterior.arquivo]);
          return { id: anterior.id, atualizado: true, empresa_id: assoc.empresa_id };
        }
        const r = db.prepare(`INSERT INTO zen_documentos (${colunas.join(', ')}) VALUES (${colunas.map(() => '?').join(', ')})`)
          .run(...Object.values(valores));
        return { id: Number(r.lastInsertRowid), atualizado: false, empresa_id: assoc.empresa_id };
      });
    } catch (err) {
      desfazer();
      throw err;
    }
  }

  function receber(corpo, tipoConteudo) {
    const { documentos, arquivoMultipart, formato } = interpretarCorpo(corpo, tipoConteudo);
    if (!documentos.length) {
      // Guarda o que chegou mesmo sem entender, para a equipe ver o formato.
      const r = db.prepare('INSERT INTO zen_documentos (titulo, arquivo_info, tipo_conteudo, payload) VALUES (?, ?, ?, ?)')
        .run('(conteúdo não reconhecido)', `Formato ${formato}; ${corpo.length} bytes.`, String(tipoConteudo ?? '').slice(0, 200) || null,
          corpo.toString('utf8').slice(0, LIMITE_PAYLOAD_GUARDADO));
      return [{ id: Number(r.lastInsertRowid), atualizado: false, empresa_id: null }];
    }
    return documentos.map((d, i) => gravarDocumento(d, { arquivoMultipart: i === 0 ? arquivoMultipart : null, tipoConteudo }));
  }

  const tokenValido = (cabecalho) => {
    if (!tokenWebhook) return false;
    const recebido = String(cabecalho ?? '').replace(/^Bearer\s+/i, '').trim();
    const a = crypto.createHash('sha256').update(recebido).digest();
    const b = crypto.createHash('sha256').update(tokenWebhook).digest();
    return crypto.timingSafeEqual(a, b);
  };

  rota('POST', '/api/zen/webhook', async ({ req, lerBruto }) => {
    if (!tokenWebhook) throw new ErroValidacao('Webhook do Questor Zen não configurado.', 503);
    if (!tokenValido(req.headers.authorization)) throw new ErroValidacao('Token inválido.', 401);
    const resultado = receber(await lerBruto(), req.headers['content-type']);
    return { ok: true, documentos: resultado.map((r) => r.id) };
  }, { publica: true, bruto: true });

  // Simula uma entrega do Zen para conferir o recebimento antes de configurar o Zen.
  rota('POST', '/api/zen/teste', ({ corpo }) => {
    const empresa = db.prepare('SELECT razao_social FROM empresas WHERE id = ?').get(Number(corpo.empresa_id));
    if (!empresa) throw new ErroValidacao('Escolha a empresa que vai receber o documento de teste.');
    const agora = new Date();
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj '
      + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 120]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj '
      + '4 0 obj<</Length 52>>stream\nBT /F1 14 Tf 20 60 Td (Documento de teste do Zen) Tj ET\nendstream endobj '
      + '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
    const doc = {
      Id: `teste-${agora.getTime()}`,
      Titulo: 'Documento de teste (simulação do Zen)',
      EhPagavel: true,
      CategoriaId: 'teste',
      CategoriaDescricao: 'Guias Federais',
      DataCriacao: agora.toISOString(),
      Observacao: 'Gerado pelo botão "Simular recebimento" do sistema.',
      Arquivo: pdf.toString('base64'),
      Status: 'Opened',
      Atributos: [
        { Nome: 'DateExpire', Valor: `20/${String(agora.getMonth() + 1).padStart(2, '0')}/${agora.getFullYear()} 00:00:00` },
        { Nome: 'Value', Valor: '123,45' },
        { Nome: 'MonthCompetence', Valor: String(agora.getMonth() + 1).padStart(2, '0') },
        { Nome: 'YearCompetence', Valor: String(agora.getFullYear()) },
      ],
      Destinatarios: [{ ClienteNome: empresa.razao_social, Usuarios: [] }],
    };
    return receber(Buffer.from(JSON.stringify(doc)), 'application/json')[0];
  }, { papel: 'escritorio', admin: true });

  rota('GET', '/api/zen/status', () => ({
    webhook_configurado: Boolean(tokenWebhook),
    ...db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(empresa_id IS NULL), 0) AS sem_empresa,
      MAX(recebido_em) AS ultimo_recebimento FROM zen_documentos`).get(),
  }), { papel: 'escritorio' });

  rota('GET', '/api/zen/documentos', ({ query }) => {
    const empresaId = Number(query.get('empresa_id')) || null;
    return db.prepare(`
      SELECT z.id, z.zen_id, z.empresa_id, z.associacao, z.titulo, z.categoria, z.status, z.cliente_nome,
             z.destinatarios_emails, z.vencimento, z.competencia, z.valor_centavos, z.nome_arquivo, z.tamanho,
             z.arquivo_info, z.recebido_em, (z.arquivo IS NOT NULL) AS tem_arquivo, e.razao_social AS empresa_nome
      FROM zen_documentos z LEFT JOIN empresas e ON e.id = z.empresa_id
      ${empresaId ? 'WHERE z.empresa_id = ?' : ''}
      ORDER BY z.recebido_em DESC, z.id DESC LIMIT 500
    `).all(...(empresaId ? [empresaId] : [])).map((l) => ({ ...l }));
  }, { papel: 'escritorio' });

  rota('GET', '/api/zen/documentos/:id', ({ params }) => {
    const d = db.prepare('SELECT z.*, e.razao_social AS empresa_nome FROM zen_documentos z LEFT JOIN empresas e ON e.id = z.empresa_id WHERE z.id = ?')
      .get(params.id);
    if (!d) throw new ErroValidacao('Documento não encontrado.', 404);
    return { ...d, arquivo: undefined, tem_arquivo: Boolean(d.arquivo) };
  }, { papel: 'escritorio' });

  rota('PUT', '/api/zen/documentos/:id/empresa', ({ params, corpo }) => {
    const empresaId = corpo.empresa_id ? Number(corpo.empresa_id) : null;
    if (empresaId && !db.prepare('SELECT 1 FROM empresas WHERE id = ?').get(empresaId)) throw new ErroValidacao('Empresa não encontrada.');
    const r = db.prepare('UPDATE zen_documentos SET empresa_id = ?, associacao = ? WHERE id = ?')
      .run(empresaId, empresaId ? 'manual' : null, params.id);
    if (!r.changes) throw new ErroValidacao('Documento não encontrado.', 404);
    return { ok: true };
  }, { papel: 'escritorio' });

  rota('DELETE', '/api/zen/documentos/:id', ({ params }) => {
    const d = db.prepare('SELECT arquivo FROM zen_documentos WHERE id = ?').get(params.id);
    if (!d) throw new ErroValidacao('Documento não encontrado.', 404);
    db.prepare('DELETE FROM zen_documentos WHERE id = ?').run(params.id);
    if (d.arquivo) apagarArquivos(pastaArquivos, [d.arquivo]);
    return { ok: true };
  }, { papel: 'escritorio', admin: true });

  rota('GET', '/api/zen/documentos/:id/arquivo', ({ usuario, params, responderBruto }) => {
    const d = db.prepare('SELECT empresa_id, arquivo, nome_arquivo, tipo_mime FROM zen_documentos WHERE id = ?').get(params.id);
    const permitido = d && (usuario.papel === 'escritorio' || (d.empresa_id && d.empresa_id === usuario.empresa_id));
    if (!permitido || !d.arquivo) throw new ErroValidacao('Arquivo não encontrado.', 404);
    responderBruto(200, lerArquivo(pastaArquivos, d.arquivo), cabecalhosDownload(d));
  }, { portal: true });

  // Portal do cliente: documentos da própria empresa.
  rota('GET', '/api/portal/documentos', ({ usuario }) => db.prepare(`
    SELECT id, titulo, categoria, observacao, vencimento, competencia, valor_centavos, nome_arquivo, tamanho,
           (arquivo IS NOT NULL) AS tem_arquivo, recebido_em
    FROM zen_documentos WHERE empresa_id = ? ORDER BY recebido_em DESC, id DESC LIMIT 500
  `).all(usuario.empresa_id).map((l) => ({ ...l })), { papel: 'cliente', portal: true });
}

module.exports = { registrarRotasZen, interpretarCorpo, lerAtributos, lerDestinatarios, normalizarNome, lerArquivoRecebido };
