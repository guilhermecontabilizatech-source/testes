'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../src/validacao');

test('valida CPF e CNPJ', () => {
  assert.equal(v.cpfValido('529.982.247-25'), true);
  assert.equal(v.cpfValido('529.982.247-24'), false);
  assert.equal(v.cpfValido('111.111.111-11'), false);
  assert.equal(v.cnpjValido('11.222.333/0001-81'), true);
  assert.equal(v.cnpjValido('11.222.333/0001-80'), false);
  assert.equal(v.documentoValido('11222333000181'), true);
});

test('converte valores em centavos', () => {
  assert.equal(v.valorParaCentavos('1.234,56'), 123456);
  assert.equal(v.valorParaCentavos('R$ 10,5'), 1050);
  assert.equal(v.valorParaCentavos('99.90'), 9990);
  assert.equal(v.valorParaCentavos(12.34), 1234);
  assert.ok(Number.isNaN(v.valorParaCentavos('abc')));
});

test('valida solicitação', () => {
  const base = {
    tipo_nota: 'NFS-e',
    tomador_documento: '11.222.333/0001-81',
    tomador_nome: 'Cliente Ltda',
    descricao: 'Consultoria',
    valor: '1.500,00',
    data_competencia: '2026-09-30',
  };
  const ok = v.validarSolicitacao(base);
  assert.equal(ok.valor_centavos, 150000);
  assert.equal(ok.tomador_documento, '11222333000181');
  assert.throws(() => v.validarSolicitacao({ ...base, tipo_nota: 'X' }), /Tipo de nota/);
  assert.throws(() => v.validarSolicitacao({ ...base, valor: '0' }), /Valor/);
  assert.throws(() => v.validarSolicitacao({ ...base, tomador_documento: '123' }), /CPF\/CNPJ/);
  assert.throws(() => v.validarSolicitacao({ ...base, descricao: ' ' }), /Descrição/);
});
