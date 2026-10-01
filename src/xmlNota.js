'use strict';

// Leitura dos principais dados de XMLs de nota fiscal, sem dependências externas.
// Formatos suportados: NF-e (modelo 55/65), NFS-e Padrão Nacional e NFS-e ABRASF (1.x e 2.x).

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodificar(t) {
  return t
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
      return ENTIDADES[e] ?? m;
    })
    .trim();
}

// Conteúdo bruto do primeiro elemento com o nome dado (ignora prefixo de namespace).
function bloco(xml, nome) {
  if (!xml) return null;
  const re = new RegExp(`<(?:[\\w-]+:)?${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${nome}>`);
  const m = re.exec(xml);
  return m ? m[1] : null;
}

// Texto do primeiro elemento encontrado, percorrendo um caminho de elementos aninhados.
function valor(xml, ...caminho) {
  let atual = xml;
  for (const nome of caminho) {
    atual = bloco(atual, nome);
    if (atual == null) return null;
  }
  return decodificar(atual);
}

function primeiro(...valores) {
  return valores.find((v) => v != null && v !== '') ?? null;
}

function remover(xml, ...nomes) {
  let r = xml;
  for (const n of nomes) {
    r = r.replace(new RegExp(`<(?:[\\w-]+:)?${n}(?:\\s[^>]*)?>[\\s\\S]*?</(?:[\\w-]+:)?${n}>`, 'g'), '');
  }
  return r;
}

const data = (v) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const digitos = (v) => (v ? v.replace(/\D/g, '') || null : null);
function centavos(v) {
  if (!v) return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function lerNfe(xml) {
  const inf = bloco(xml, 'infNFe');
  const produtos = [...inf.matchAll(/<(?:[\w-]+:)?xProd>([\s\S]*?)<\/(?:[\w-]+:)?xProd>/g)].map((m) => decodificar(m[1]));
  const descricao = produtos.length
    ? `${produtos.slice(0, 5).join('; ')}${produtos.length > 5 ? `; e mais ${produtos.length - 5} item(ns)` : ''}`
    : null;
  const dest = bloco(inf, 'dest');
  return {
    formato: 'NF-e',
    tipo_nota: 'NF-e',
    numero: valor(inf, 'ide', 'nNF'),
    data_emissao: data(primeiro(valor(inf, 'ide', 'dhEmi'), valor(inf, 'ide', 'dEmi'))),
    emitente_documento: digitos(primeiro(valor(inf, 'emit', 'CNPJ'), valor(inf, 'emit', 'CPF'))),
    emitente_nome: valor(inf, 'emit', 'xNome'),
    tomador_documento: digitos(primeiro(valor(dest, 'CNPJ'), valor(dest, 'CPF'))),
    tomador_nome: valor(dest, 'xNome'),
    tomador_email: valor(dest, 'email'),
    valor_centavos: centavos(valor(inf, 'total', 'ICMSTot', 'vNF')),
    descricao,
  };
}

function lerNfseNacional(xml) {
  const inf = bloco(xml, 'infNFSe');
  const dps = bloco(inf, 'infDPS') ?? '';
  const toma = bloco(dps, 'toma');
  return {
    formato: 'NFS-e Padrão Nacional',
    tipo_nota: 'NFS-e',
    numero: valor(inf, 'nNFSe'),
    data_emissao: data(primeiro(valor(dps, 'dhEmi'), valor(inf, 'dhProc'))),
    emitente_documento: digitos(primeiro(valor(inf, 'emit', 'CNPJ'), valor(inf, 'emit', 'CPF'), valor(dps, 'prest', 'CNPJ'), valor(dps, 'prest', 'CPF'))),
    emitente_nome: primeiro(valor(inf, 'emit', 'xNome'), valor(dps, 'prest', 'xNome')),
    tomador_documento: digitos(primeiro(valor(toma, 'CNPJ'), valor(toma, 'CPF'))),
    tomador_nome: valor(toma, 'xNome'),
    tomador_email: valor(toma, 'email'),
    valor_centavos: centavos(primeiro(valor(dps, 'valores', 'vServPrest', 'vServ'), valor(inf, 'valores', 'vLiq'))),
    descricao: valor(dps, 'serv', 'cServ', 'xDescServ'),
  };
}

function lerNfseAbrasf(xml) {
  const inf = bloco(xml, 'InfNfse');
  // "Numero" também aparece no endereço e no RPS; procura só no nível da nota.
  const numero = valor(remover(inf, 'Endereco', 'IdentificacaoRps', 'Rps', 'DeclaracaoPrestacaoServico', 'NfseSubstituida', 'PrestadorServico', 'TomadorServico', 'OrgaoGerador'), 'Numero');
  // O prestador aparece em blocos diferentes conforme a versão (1.x: PrestadorServico; 2.x: Prestador).
  const prestadores = ['PrestadorServico', 'Prestador', 'IdentificacaoPrestador'].map((n) => bloco(inf, n));
  const doPrestador = (campo) => primeiro(...prestadores.map((b) => valor(b, campo)));
  const toma = primeiro(bloco(inf, 'TomadorServico'), bloco(inf, 'Tomador'));
  return {
    formato: 'NFS-e ABRASF',
    tipo_nota: 'NFS-e',
    numero,
    data_emissao: data(primeiro(valor(inf, 'DataEmissao'), valor(inf, 'Competencia'))),
    emitente_documento: digitos(primeiro(doPrestador('Cnpj'), doPrestador('Cpf'))),
    emitente_nome: doPrestador('RazaoSocial'),
    tomador_documento: digitos(primeiro(valor(toma, 'Cnpj'), valor(toma, 'Cpf'))),
    tomador_nome: valor(toma, 'RazaoSocial'),
    tomador_email: valor(toma, 'Email'),
    valor_centavos: centavos(primeiro(valor(inf, 'ValorServicos'), valor(inf, 'ValoresNfse', 'ValorLiquidoNfse'))),
    descricao: valor(inf, 'Discriminacao'),
  };
}

// Devolve os dados encontrados ou null se o XML não for de um formato reconhecido.
function lerXmlNota(conteudo) {
  const xml = String(conteudo).replace(/^﻿/, '');
  if (bloco(xml, 'infNFe')) return lerNfe(xml);
  if (bloco(xml, 'infNFSe')) return lerNfseNacional(xml);
  if (bloco(xml, 'InfNfse')) return lerNfseAbrasf(xml);
  return null;
}

module.exports = { lerXmlNota };
