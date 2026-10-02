'use strict';

class ErroValidacao extends Error {
  constructor(mensagem, status = 400) {
    super(mensagem);
    this.status = status;
  }
}

const apenasDigitos = (valor) => String(valor ?? '').replace(/\D/g, '');

function digitoVerificador(digitos, pesos) {
  const soma = pesos.reduce((acc, peso, i) => acc + Number(digitos[i]) * peso, 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

function cpfValido(valor) {
  const d = apenasDigitos(valor);
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  const dv1 = digitoVerificador(d, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const dv2 = digitoVerificador(d, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return dv1 === Number(d[9]) && dv2 === Number(d[10]);
}

function cnpjValido(valor) {
  const d = apenasDigitos(valor);
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const dv1 = digitoVerificador(d, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const dv2 = digitoVerificador(d, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return dv1 === Number(d[12]) && dv2 === Number(d[13]);
}

function documentoValido(valor) {
  const d = apenasDigitos(valor);
  return d.length === 11 ? cpfValido(d) : cnpjValido(d);
}

function emailValido(valor) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(valor ?? ''));
}

// Converte "1.234,56", "1234.56" ou 1234.56 em centavos (inteiro).
function valorParaCentavos(valor) {
  if (typeof valor === 'number') {
    return Number.isFinite(valor) ? Math.round(valor * 100) : NaN;
  }
  let texto = String(valor ?? '').trim().replace(/^R\$\s*/, '');
  if (texto.includes(',')) texto = texto.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(texto)) return NaN;
  return Math.round(Number(texto) * 100);
}

function texto(campo, valor, { obrigatorio = false, max = 500 } = {}) {
  const t = String(valor ?? '').trim();
  if (obrigatorio && !t) throw new ErroValidacao(`O campo "${campo}" é obrigatório.`);
  if (t.length > max) throw new ErroValidacao(`O campo "${campo}" excede ${max} caracteres.`);
  return t || null;
}

const TIPOS_NOTA = ['NFS-e', 'NF-e'];

// Valida e normaliza os dados de uma solicitação enviados pelo cliente.
function validarSolicitacao(dados) {
  const tipo_nota = dados.tipo_nota;
  if (!TIPOS_NOTA.includes(tipo_nota)) {
    throw new ErroValidacao('Tipo de nota inválido. Use NFS-e ou NF-e.');
  }

  const tomador_documento = apenasDigitos(dados.tomador_documento);
  if (!documentoValido(tomador_documento)) {
    throw new ErroValidacao('CPF/CNPJ do tomador inválido.');
  }

  const tomador_email = texto('E-mail do tomador', dados.tomador_email, { max: 200 });
  if (tomador_email && !emailValido(tomador_email)) {
    throw new ErroValidacao('E-mail do tomador inválido.');
  }

  const valor_centavos = valorParaCentavos(dados.valor);
  if (!Number.isInteger(valor_centavos) || valor_centavos <= 0) {
    throw new ErroValidacao('Valor da nota inválido.');
  }

  const data_competencia = String(dados.data_competencia ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data_competencia) || Number.isNaN(Date.parse(data_competencia))) {
    throw new ErroValidacao('Data de competência inválida (use AAAA-MM-DD).');
  }

  return {
    tipo_nota,
    tomador_documento,
    tomador_nome: texto('Nome do tomador', dados.tomador_nome, { obrigatorio: true, max: 200 }),
    tomador_email,
    tomador_endereco: texto('Endereço do tomador', dados.tomador_endereco, { max: 300 }),
    descricao: texto('Descrição', dados.descricao, { obrigatorio: true, max: 2000 }),
    valor_centavos,
    data_competencia,
    observacoes: texto('Observações', dados.observacoes, { max: 2000 }),
  };
}

const CANAIS_PEDIDO = {
  whatsapp: 'WhatsApp',
  email: 'E-mail',
  telefone: 'Telefone',
  presencial: 'Presencial',
  outro: 'Outro',
};

function dataValidaISO(valor) {
  return /^\d{4}-\d{2}-\d{2}$/.test(valor) && !Number.isNaN(Date.parse(valor));
}

// Nota fiscal registrada pelo escritório: só número e data de emissão são obrigatórios.
function validarNota(dados) {
  const numero_nota = texto('Número da nota', dados.numero_nota, { obrigatorio: true, max: 50 });
  const data_emissao = String(dados.data_emissao ?? '');
  if (!dataValidaISO(data_emissao)) throw new ErroValidacao('Data de emissão inválida.');

  const tipo_nota = dados.tipo_nota || null;
  if (tipo_nota && !TIPOS_NOTA.includes(tipo_nota)) throw new ErroValidacao('Tipo de nota inválido. Use NFS-e ou NF-e.');

  const tomador_documento = apenasDigitos(dados.tomador_documento) || null;
  if (tomador_documento && !documentoValido(tomador_documento)) throw new ErroValidacao('CPF/CNPJ do tomador inválido.');

  const tomador_email = texto('E-mail do tomador', dados.tomador_email, { max: 200 });
  if (tomador_email && !emailValido(tomador_email)) throw new ErroValidacao('E-mail do tomador inválido.');

  let valor_centavos = null;
  if (dados.valor !== undefined && dados.valor !== null && String(dados.valor).trim() !== '') {
    valor_centavos = valorParaCentavos(dados.valor);
    if (!Number.isInteger(valor_centavos) || valor_centavos <= 0) throw new ErroValidacao('Valor da nota inválido.');
  }

  const canal_pedido = dados.canal_pedido || null;
  if (canal_pedido && !CANAIS_PEDIDO[canal_pedido]) throw new ErroValidacao('Canal do pedido inválido.');
  const canal_outro = canal_pedido === 'outro'
    ? texto('Descrição do canal', dados.canal_outro, { obrigatorio: true, max: 100 })
    : null;

  const data_pedido = dados.data_pedido ? String(dados.data_pedido) : null;
  if (data_pedido && !dataValidaISO(data_pedido)) throw new ErroValidacao('Data do pedido inválida.');
  if (data_pedido && data_pedido > data_emissao) throw new ErroValidacao('A data do pedido não pode ser depois da emissão.');

  return {
    numero_nota,
    data_emissao,
    tipo_nota,
    tomador_documento,
    tomador_nome: texto('Nome do tomador', dados.tomador_nome, { max: 200 }),
    tomador_email,
    descricao: texto('Descrição', dados.descricao, { max: 2000 }),
    valor_centavos,
    canal_pedido,
    canal_outro,
    data_pedido,
  };
}

module.exports = {
  CANAIS_PEDIDO,
  validarNota,
  dataValidaISO,
  ErroValidacao,
  apenasDigitos,
  cpfValido,
  cnpjValido,
  documentoValido,
  emailValido,
  valorParaCentavos,
  texto,
  validarSolicitacao,
  TIPOS_NOTA,
};
