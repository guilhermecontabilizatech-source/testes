'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ErroValidacao, texto } = require('./validacao');

const LIMITE_ANEXO = 10 * 1024 * 1024;
const TIPOS_ANEXO = {
  'application/pdf': '.pdf',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'image/png': '.png',
  'image/jpeg': '.jpg',
};

// Valida e decodifica um arquivo enviado em base64, sem gravar nada ainda.
function prepararArquivo({ nome_arquivo, tipo_mime, conteudo_base64 } = {}) {
  let tipo = tipo_mime;
  const nome = texto('Nome do arquivo', nome_arquivo, { obrigatorio: true, max: 200 }).replace(/[\\/\0]/g, '_');
  if (!tipo && /\.xml$/i.test(nome)) tipo = 'application/xml';
  const extensao = TIPOS_ANEXO[tipo];
  if (!extensao) throw new ErroValidacao(`Tipo de arquivo não permitido (${nome}). Envie PDF, XML, PNG ou JPG.`);
  const conteudo = Buffer.from(String(conteudo_base64 ?? ''), 'base64');
  if (!conteudo.length) throw new ErroValidacao(`Arquivo vazio: ${nome}.`);
  if (conteudo.length > LIMITE_ANEXO) throw new ErroValidacao(`Arquivo maior que 10 MB: ${nome}.`);
  return { nome, tipo_mime: tipo, extensao, conteudo };
}

function prepararArquivos(lista) {
  if (lista == null) return [];
  if (!Array.isArray(lista)) throw new ErroValidacao('Lista de arquivos inválida.');
  if (lista.length > 10) throw new ErroValidacao('Envie no máximo 10 arquivos por vez.');
  return lista.map(prepararArquivo);
}

// Grava os arquivos já validados com nomes aleatórios. Devolve também uma função
// para apagá-los caso a gravação no banco falhe.
function gravarArquivos(pasta, preparados) {
  const gravados = [];
  try {
    for (const a of preparados) {
      const arquivo = `${crypto.randomUUID()}${a.extensao}`;
      fs.writeFileSync(path.join(pasta, arquivo), a.conteudo);
      gravados.push({ nome: a.nome, tipo_mime: a.tipo_mime, tamanho: a.conteudo.length, arquivo });
    }
  } catch (err) {
    desfazer();
    throw err;
  }
  function desfazer() {
    for (const g of gravados) fs.rmSync(path.join(pasta, g.arquivo), { force: true });
  }
  return { gravados, desfazer };
}

function apagarArquivos(pasta, nomes) {
  for (const nome of nomes) fs.rmSync(path.join(pasta, path.basename(nome)), { force: true });
}

function lerArquivo(pasta, arquivo) {
  return fs.readFileSync(path.join(pasta, path.basename(arquivo)));
}

const cabecalhosDownload = (a) => ({
  'Content-Type': a.tipo_mime,
  'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.nome_arquivo)}`,
});

module.exports = { prepararArquivo, prepararArquivos, gravarArquivos, apagarArquivos, lerArquivo, cabecalhosDownload, TIPOS_ANEXO };
