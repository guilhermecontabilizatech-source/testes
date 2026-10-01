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

module.exports = {
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
