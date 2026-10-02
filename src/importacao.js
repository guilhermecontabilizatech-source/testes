'use strict';

// Importação de empresas a partir de planilha (CSV/XLSX) ou PDF com a relação de clientes.
// Todo formato vira uma lista de linhas, cada uma com células { x, texto }:
// em planilhas x é o número da coluna; no PDF, a posição horizontal do texto na página.

const zlib = require('node:zlib');
const { ErroValidacao, apenasDigitos, cnpjValido, cpfValido, emailValido, lerRegime, valorParaCentavos } = require('./validacao');
const { decodificar } = require('./xmlNota');

// ---------------------------------------------------------------------------
// Leitura dos formatos
// ---------------------------------------------------------------------------

function decodificarTexto(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^﻿/, '');
  } catch {
    // CSV salvo pelo Excel em português costuma vir em Windows-1252.
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

function lerCsv(buffer) {
  const texto = decodificarTexto(buffer);
  const primeira = texto.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const separador = [';', '\t', ','].reduce((melhor, s) => (primeira.split(s).length > primeira.split(melhor).length ? s : melhor), ';');

  const linhas = [];
  let linha = [];
  let celula = '';
  let aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"' && texto[i + 1] === '"') { celula += '"'; i++; } else if (c === '"') aspas = false; else celula += c;
    } else if (c === '"') aspas = true;
    else if (c === separador) { linha.push(celula); celula = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      linha.push(celula); linhas.push(linha); linha = []; celula = '';
    } else celula += c;
  }
  if (celula || linha.length) { linha.push(celula); linhas.push(linha); }
  return linhas.map((l, i) => numerar(l.map((texto, x) => ({ x, texto: texto.trim() })), i + 1));
}

// Guarda na própria linha o número que ela tem no arquivo (para mostrar ao usuário).
function numerar(celulas, numero) {
  celulas.numero = numero;
  return celulas;
}

// Leitor mínimo de ZIP (o .xlsx é um ZIP de arquivos XML).
function lerZip(buffer) {
  const fim = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (fim < 0) throw new ErroValidacao('Arquivo .xlsx inválido ou corrompido.');
  const total = buffer.readUInt16LE(fim + 10);
  let p = buffer.readUInt32LE(fim + 16);
  const arquivos = new Map();
  for (let i = 0; i < total; i++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = buffer.readUInt16LE(p + 10);
    const tamanho = buffer.readUInt32LE(p + 20);
    const nomeLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const comentarioLen = buffer.readUInt16LE(p + 32);
    const local = buffer.readUInt32LE(p + 42);
    const nome = buffer.toString('utf8', p + 46, p + 46 + nomeLen);
    arquivos.set(nome, () => {
      const inicio = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const dados = buffer.subarray(inicio, inicio + tamanho);
      return metodo === 8 ? zlib.inflateRawSync(dados) : dados;
    });
    p += 46 + nomeLen + extraLen + comentarioLen;
  }
  return { ler: (nome) => arquivos.get(nome)?.().toString('utf8') ?? null };
}

const textosDe = (xml) => [...xml.replace(/<rPh[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
  .map((m) => decodificar(m[1])).join('');

function colunaParaIndice(ref) {
  let n = 0;
  for (const letra of ref.replace(/\d+/g, '')) n = n * 26 + (letra.charCodeAt(0) - 64);
  return n - 1;
}

function lerXlsx(buffer) {
  const zip = lerZip(buffer);
  const workbook = zip.ler('xl/workbook.xml');
  if (!workbook) throw new ErroValidacao('Arquivo .xlsx inválido.');
  // Primeira aba da pasta de trabalho.
  const idAba = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
  const rels = zip.ler('xl/_rels/workbook.xml.rels') ?? '';
  const alvo = new RegExp(`<Relationship\\b[^>]*Id="${idAba}"[^>]*Target="([^"]+)"`).exec(rels)?.[1]
    ?? new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${idAba}"`).exec(rels)?.[1]
    ?? 'worksheets/sheet1.xml';
  const caminho = alvo.startsWith('/') ? alvo.slice(1) : `xl/${alvo}`;
  const planilha = zip.ler(caminho);
  if (!planilha) throw new ErroValidacao('Não encontrei a primeira aba da planilha.');

  const compartilhados = [...(zip.ler('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textosDe(m[1]));

  const linhas = new Map();
  for (const m of planilha.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = m[1];
    const conteudo = m[2] ?? '';
    const ref = /\br="([A-Z]+)(\d+)"/.exec(attrs);
    if (!ref) continue;
    const tipo = /\bt="([^"]+)"/.exec(attrs)?.[1];
    const v = /<v>([\s\S]*?)<\/v>/.exec(conteudo)?.[1];
    let texto;
    if (tipo === 's') texto = compartilhados[Number(v)] ?? '';
    else if (tipo === 'inlineStr') texto = textosDe(conteudo);
    else texto = v == null ? '' : decodificar(v);
    // Números grandes (CNPJ sem formatação) podem vir em notação científica.
    if (!tipo && /^\d+(\.\d+)?E\+?\d+$/i.test(texto)) texto = Number(texto).toFixed(0);
    const numLinha = Number(ref[2]);
    if (!linhas.has(numLinha)) linhas.set(numLinha, []);
    linhas.get(numLinha).push({ x: colunaParaIndice(ref[1]), texto: texto.trim() });
  }
  return [...linhas.entries()].sort((a, b) => a[0] - b[0])
    .map(([numero, celulas]) => numerar(celulas.sort((a, b) => a.x - b.x), numero));
}

// Textos que são um valor inteiro (CNPJ/CPF, e-mail, telefone, código numérico) nunca são
// unidos ao vizinho: em tabelas apertadas a distância entre colunas é parecida com a de um espaço.
const ATOMICO = /^(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}|\d{3}\.?\d{3}\.?\d{3}-?\d{2}|[^\s@]+@[^\s@]+\.[^\s@]+|\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}|\d+)$/;

async function lerPdf(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const tarefa = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, verbosity: 0 });
  let doc;
  try {
    doc = await tarefa.promise;
  } catch {
    throw new ErroValidacao('Não consegui abrir este PDF. Verifique se ele não está protegido por senha.');
  }
  const linhas = [];
  for (let n = 1; n <= Math.min(doc.numPages, 200); n++) {
    const pagina = await doc.getPage(n);
    const { items } = await pagina.getTextContent();
    // Agrupa os textos pela altura (y) e, dentro da linha, junta pedaços muito próximos.
    const porLinha = [];
    for (const item of items) {
      if (!item.str?.trim()) continue;
      const [, , , , x, y] = item.transform;
      let linha = porLinha.find((l) => Math.abs(l.y - y) <= 2);
      if (!linha) porLinha.push(linha = { y, itens: [] });
      linha.itens.push({ x, fim: x + item.width, texto: item.str, altura: item.height || 10 });
    }
    porLinha.sort((a, b) => b.y - a.y);
    for (const { itens } of porLinha) {
      itens.sort((a, b) => a.x - b.x);
      const celulas = [];
      for (const it of itens) {
        const ultima = celulas.at(-1);
        // Pedaços separados por menos que um espaço (até ~0,7 da altura da letra, o que cobre
        // fontes de largura fixa como Courier) pertencem ao mesmo texto.
        const unir = ultima && it.x - ultima.fim < Math.max(3, it.altura * 0.7)
          && !ATOMICO.test(it.texto.trim()) && !ATOMICO.test(ultima.texto.trim());
        if (unir) {
          ultima.texto += (it.x - ultima.fim > 1 ? ' ' : '') + it.texto;
          ultima.fim = it.fim;
        } else celulas.push({ ...it });
      }
      const preenchidas = celulas.filter((c) => c.texto.trim())
        .map(({ x, fim, texto }) => ({ x, fim, texto: texto.replace(/\s+/g, ' ').trim() }));
      if (preenchidas.length) linhas.push(preenchidas);
    }
  }
  await tarefa.destroy();
  return linhas;
}

async function lerLinhas(nomeArquivo, buffer) {
  const ext = String(nomeArquivo).toLowerCase().split('.').pop();
  if (ext === 'csv' || ext === 'txt') return { origem: 'planilha', linhas: lerCsv(buffer) };
  if (ext === 'xlsx') return { origem: 'planilha', linhas: lerXlsx(buffer) };
  if (ext === 'pdf') return { origem: 'pdf', linhas: await lerPdf(buffer) };
  if (ext === 'xls') throw new ErroValidacao('Planilhas .xls antigas não são lidas. No Excel, use "Salvar como" → .xlsx ou .csv.');
  throw new ErroValidacao('Envie uma planilha (.xlsx ou .csv) ou um PDF.');
}

// ---------------------------------------------------------------------------
// Reconhecimento das colunas e das empresas
// ---------------------------------------------------------------------------

const normalizar = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();

// Para cada campo, padrões de cabeçalho em ordem de preferência.
const CAMPOS = {
  cnpj: [/cnpj/, /^cpf/, /^documento/, /inscricao/],
  razao_social: [/razao/, /nome empresarial/, /^(nome da )?empresa$/, /^(nome do )?cliente$/, /^nome$/],
  email: [/e ?mail/],
  telefone: [/telefone|^fone|celular|whats/],
  plano_notas: [/plano de notas|tem plano/],
  plano_nome: [/^plano$|nome do plano|plano contratado/],
  notas_incluidas: [/notas? inclu|franquia|notas? mes|qtd notas|quantidade de notas/],
  honorario: [/honorario|mensalidade/],
  regime: [/regime|tributacao|enquadramento/],
};

const ROTULOS_CAMPOS = {
  cnpj: 'CNPJ', razao_social: 'Razão social', email: 'E-mail', telefone: 'Telefone',
  plano_notas: 'Tem plano de notas', plano_nome: 'Plano', notas_incluidas: 'Notas incluídas', honorario: 'Honorário',
  regime: 'Regime tributário',
};

function detectarCabecalho(linhas) {
  for (let i = 0; i < Math.min(linhas.length, 30); i++) {
    const colunas = {};
    for (const [campo, padroes] of Object.entries(CAMPOS)) {
      for (const padrao of padroes) {
        const celula = linhas[i].find((c) => padrao.test(normalizar(c.texto)) && !Object.values(colunas).includes(c));
        if (celula) { colunas[campo] = celula; break; }
      }
    }
    if ('cnpj' in colunas && 'razao_social' in colunas) return { indice: i, colunas, titulos: linhas[i] };
  }
  return null;
}

const RE_CNPJ = /\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/;
const RE_EMAIL = /[^\s@;,]+@[^\s@;,]+\.[^\s@;,]+/;
const RE_TELEFONE = /(?<!\d)\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}(?!\d)/;

function normalizarDocumento(texto) {
  let d = apenasDigitos(texto);
  // Planilhas guardam CNPJ como número e perdem os zeros à esquerda.
  if (d.length >= 12 && d.length < 14) d = d.padStart(14, '0');
  return d;
}

function lerSimNao(texto) {
  const t = normalizar(texto);
  if (!t) return null;
  if (/^(s|sim|x|1|true|yes|y)$/.test(t)) return true;
  if (/^(n|nao|0|false|no)$/.test(t)) return false;
  return null;
}

// No PDF, cada texto pertence à coluna cujo título mais se sobrepõe a ele na horizontal
// (títulos costumam vir centralizados e os valores alinhados à esquerda); sem sobreposição,
// vale o título de centro mais próximo.
function tituloDaCelula(celula, titulos) {
  const centro = (c) => (c.x + c.fim) / 2;
  let melhor = null;
  let melhorSobreposicao = 0;
  for (const t of titulos) {
    const sobreposicao = Math.min(celula.fim, t.fim) - Math.max(celula.x, t.x);
    if (sobreposicao > melhorSobreposicao) { melhor = t; melhorSobreposicao = sobreposicao; }
  }
  return melhor ?? titulos.reduce((a, b) => (Math.abs(centro(b) - centro(celula)) < Math.abs(centro(a) - centro(celula)) ? b : a));
}

function celulaDaColuna(celulas, cabecalho, campo, exato) {
  const titulo = cabecalho.colunas[campo];
  if (!titulo) return null;
  const textos = celulas.filter((c) => (exato ? c.x === titulo.x : tituloDaCelula(c, cabecalho.titulos) === titulo))
    .map((c) => c.texto).filter(Boolean);
  return textos.length ? textos.join(' ') : null;
}

function extrairEmpresa(celulas, cabecalho, exato) {
  const textoLinha = celulas.map((c) => c.texto).join('  ');
  const daColuna = (campo) => (cabecalho ? celulaDaColuna(celulas, cabecalho, campo, exato) : null);

  const docColuna = normalizarDocumento(daColuna('cnpj') ?? '');
  const documento = docColuna.length >= 11 ? docColuna : normalizarDocumento(RE_CNPJ.exec(textoLinha)?.[0] ?? '');
  const email = (daColuna('email') || RE_EMAIL.exec(textoLinha)?.[0] || '').trim() || null;
  const temColunaTelefone = Boolean(cabecalho?.colunas.telefone);
  const telefone = (daColuna('telefone') || (temColunaTelefone ? '' : RE_TELEFONE.exec(textoLinha.replace(RE_CNPJ, ''))?.[0]) || '')
    .trim() || null;

  let razao = (daColuna('razao_social') ?? '').replace(RE_CNPJ, '').replace(RE_EMAIL, '');
  if (!cabecalho) {
    // Sem coluna identificada: o maior texto da linha que não seja CNPJ, e-mail, telefone ou código.
    razao = celulas
      .map((c) => c.texto.replace(RE_CNPJ, '').replace(RE_EMAIL, '').replace(/\b(cnpj|cpf|raz[aã]o social|nome|e-?mail)\s*:?/gi, '')
        .replace(/^\s*\d+\s*[.)\-–]\s+/, '').replace(/^[\s\-–:|]+|[\s\-–:|]+$/g, '').trim())
      .filter((t) => /[a-zà-ú]{3}/i.test(t) && !RE_TELEFONE.test(t))
      .sort((a, b) => b.length - a.length)[0] ?? '';
  }

  const planoTexto = daColuna('plano_notas');
  const planoNome = daColuna('plano_nome');
  const notasTexto = daColuna('notas_incluidas');
  const honorarioTexto = daColuna('honorario');
  const notas = notasTexto && /\d/.test(notasTexto) ? parseInt(apenasDigitos(notasTexto), 10) : null;
  const honorario = honorarioTexto ? valorParaCentavos(honorarioTexto) : null;
  let planoNotas = lerSimNao(planoTexto);
  if (planoNotas == null && (planoNome || notas != null)) planoNotas = true;

  return {
    cnpj: documento,
    razao_social: razao.replace(/\s+/g, ' ').trim(),
    email,
    telefone,
    plano_informado: planoNotas != null,
    plano_notas: planoNotas ?? false,
    plano_nome: planoNome || null,
    notas_incluidas: Number.isInteger(notas) ? notas : null,
    honorario_centavos: Number.isInteger(honorario) ? honorario : null,
    regime: lerRegime(daColuna('regime')),
  };
}

// Transforma as linhas lidas em empresas candidatas, com a situação de cada uma.
function analisarLinhas({ origem, linhas }, cnpjsExistentes) {
  const primeiro = detectarCabecalho(linhas);
  let cabecalho = primeiro;
  const exato = origem === 'planilha';
  const resultado = [];
  const vistos = new Set();

  linhas.forEach((celulas, i) => {
    if (primeiro && i <= primeiro.indice) return;
    if (!celulas.some((c) => c.texto)) return;
    // Cabeçalho repetido (por exemplo, em cada página do PDF): as colunas podem mudar de
    // posição, então passa a valer o novo.
    const repetido = primeiro && detectarCabecalho([celulas]);
    if (repetido) { cabecalho = repetido; return; }

    const e = extrairEmpresa(celulas, cabecalho, exato);
    const temDocumento = e.cnpj.length >= 11;
    // No PDF, linhas sem CNPJ são títulos, rodapés ou nomes quebrados em duas linhas.
    if (!temDocumento && (origem === 'pdf' || !e.razao_social)) return;

    let situacao = 'nova';
    let mensagem = null;
    if (!temDocumento) {
      situacao = 'erro'; mensagem = 'CNPJ não encontrado nesta linha.';
    } else if (e.cnpj.length === 11 && cpfValido(e.cnpj)) {
      situacao = 'erro'; mensagem = 'É um CPF: pessoas físicas são cadastradas uma a uma, em "+ Nova empresa".';
    } else if (!cnpjValido(e.cnpj)) {
      situacao = 'erro'; mensagem = 'CNPJ inválido (dígito verificador não confere).';
    } else if (!e.razao_social) {
      situacao = 'erro'; mensagem = 'Razão social não encontrada.';
    } else if (vistos.has(e.cnpj)) {
      situacao = 'erro'; mensagem = 'CNPJ repetido no arquivo.';
    } else if (cnpjsExistentes.has(e.cnpj)) {
      situacao = 'existente'; mensagem = `Já cadastrada como "${cnpjsExistentes.get(e.cnpj)}".`;
    }
    if (e.email && !emailValido(e.email)) e.email = null;
    if (temDocumento) vistos.add(e.cnpj);
    resultado.push({ linha: celulas.numero ?? null, ...e, situacao, mensagem });
  });

  const colunas = primeiro
    ? Object.keys(primeiro.colunas).map((c) => ROTULOS_CAMPOS[c])
    : [];
  return { origem, colunas_reconhecidas: colunas, empresas: resultado };
}

const MODELO_CSV = 'CNPJ;Razão social;E-mail;Telefone;Regime;Plano;Notas incluídas;Honorário\r\n'
  + '11.222.333/0001-81;Exemplo Comércio Ltda;contato@exemplo.com.br;(11) 99999-0000;Simples Nacional;Essencial;10;450,00\r\n';

module.exports = { lerLinhas, analisarLinhas, lerCsv, lerXlsx, lerZip, MODELO_CSV };
