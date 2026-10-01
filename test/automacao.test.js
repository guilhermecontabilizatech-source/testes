'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { abrirBanco } = require('../src/db');
const { criarApp } = require('../src/app');
const { gerarHash } = require('../src/auth');
const { lerXmlNota } = require('../src/xmlNota');

const CNPJ_EMPRESA = '11222333000181';

const XML_NFE = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe352610" versao="4.00">
<ide><cUF>35</cUF><nNF>4521</nNF><dhEmi>2026-11-03T10:15:00-03:00</dhEmi></ide>
<emit><CNPJ>${CNPJ_EMPRESA}</CNPJ><xNome>Padaria Boa</xNome><enderEmit><nro>10</nro></enderEmit></emit>
<dest><CNPJ>11444777000161</CNPJ><xNome>Eventos &amp; Festas Ltda</xNome><email>fin@eventos.com</email></dest>
<det nItem="1"><prod><xProd>Kit café da manhã</xProd></prod></det>
<det nItem="2"><prod><xProd>Bolo de chocolate</xProd></prod></det>
<total><ICMSTot><vProd>1500.00</vProd><vNF>1500.00</vNF></ICMSTot></total>
</infNFe></NFe></nfeProc>`;

const XML_NFSE_NACIONAL = `<?xml version="1.0" encoding="utf-8"?>
<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00"><infNFSe Id="NFS123">
<nNFSe>87</nNFSe><dhProc>2026-10-20T09:00:00-03:00</dhProc>
<emit><CNPJ>${CNPJ_EMPRESA}</CNPJ><xNome>Padaria Boa</xNome></emit>
<valores><vLiq>2400.00</vLiq></valores>
<DPS versao="1.00"><infDPS Id="DPS1"><dhEmi>2026-10-20T08:59:00-03:00</dhEmi>
<prest><CNPJ>${CNPJ_EMPRESA}</CNPJ></prest>
<toma><CPF>52998224725</CPF><xNome>Maria Tomadora</xNome><email>maria@x.com</email></toma>
<serv><cServ><cTribNac>010101</cTribNac><xDescServ>Consultoria em gestão</xDescServ></cServ></serv>
<valores><vServPrest><vServ>2500.00</vServ></vServPrest></valores>
</infDPS></DPS></infNFSe></NFSe>`;

const XML_ABRASF = `<?xml version="1.0" encoding="UTF-8"?>
<CompNfse xmlns="http://www.abrasf.org.br/nfse.xsd"><Nfse versao="2.02"><InfNfse Id="1">
<Numero>202600000000015</Numero><CodigoVerificacao>ABC</CodigoVerificacao><DataEmissao>2026-12-05T14:00:00</DataEmissao>
<ValoresNfse><ValorLiquidoNfse>780.50</ValorLiquidoNfse></ValoresNfse>
<PrestadorServico><RazaoSocial>Padaria Boa</RazaoSocial><Endereco><Numero>999</Numero></Endereco></PrestadorServico>
<DeclaracaoPrestacaoServico><InfDeclaracaoPrestacaoServico>
<Rps><IdentificacaoRps><Numero>55</Numero></IdentificacaoRps></Rps><Competencia>2026-12-01</Competencia>
<Servico><Valores><ValorServicos>800.00</ValorServicos></Valores><Discriminacao>Manutenção mensal &lt;dezembro&gt;</Discriminacao></Servico>
<Prestador><CpfCnpj><Cnpj>${CNPJ_EMPRESA}</Cnpj></CpfCnpj></Prestador>
<Tomador><IdentificacaoTomador><CpfCnpj><Cnpj>11444777000161</Cnpj></CpfCnpj></IdentificacaoTomador>
<RazaoSocial>Condomínio Sol</RazaoSocial><Endereco><Numero>77</Numero></Endereco><Contato><Email>sindico@sol.com</Email></Contato></Tomador>
</InfDeclaracaoPrestacaoServico></DeclaracaoPrestacaoServico></InfNfse></Nfse></CompNfse>`;

test('lê NF-e', () => {
  const d = lerXmlNota(XML_NFE);
  assert.equal(d.formato, 'NF-e');
  assert.equal(d.numero, '4521');
  assert.equal(d.data_emissao, '2026-11-03');
  assert.equal(d.emitente_documento, CNPJ_EMPRESA);
  assert.equal(d.tomador_documento, '11444777000161');
  assert.equal(d.tomador_nome, 'Eventos & Festas Ltda');
  assert.equal(d.valor_centavos, 150000);
  assert.equal(d.descricao, 'Kit café da manhã; Bolo de chocolate');
});

test('lê NFS-e Padrão Nacional', () => {
  const d = lerXmlNota(XML_NFSE_NACIONAL);
  assert.equal(d.tipo_nota, 'NFS-e');
  assert.equal(d.numero, '87');
  assert.equal(d.data_emissao, '2026-10-20');
  assert.equal(d.emitente_documento, CNPJ_EMPRESA);
  assert.equal(d.tomador_documento, '52998224725');
  assert.equal(d.valor_centavos, 250000);
  assert.equal(d.descricao, 'Consultoria em gestão');
});

test('lê NFS-e ABRASF sem confundir número do endereço ou do RPS', () => {
  const d = lerXmlNota(XML_ABRASF);
  assert.equal(d.numero, '202600000000015');
  assert.equal(d.data_emissao, '2026-12-05');
  assert.equal(d.emitente_documento, CNPJ_EMPRESA);
  assert.equal(d.tomador_documento, '11444777000161');
  assert.equal(d.tomador_nome, 'Condomínio Sol');
  assert.equal(d.tomador_email, 'sindico@sol.com');
  assert.equal(d.valor_centavos, 80000);
  assert.equal(d.descricao, 'Manutenção mensal <dezembro>');
});

test('XML desconhecido devolve null', () => {
  assert.equal(lerXmlNota('<qualquer><coisa/></qualquer>'), null);
});

// ---------------------------------------------------------------------------

let servidor;
let base;
let pasta;

test.before(async () => {
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'notas-auto-'));
  const db = abrirBanco(':memory:');
  db.prepare("INSERT INTO usuarios (nome, email, senha_hash, papel) VALUES ('Admin', 'admin@x.com', ?, 'escritorio')")
    .run(gerarHash('senha-admin'));
  servidor = http.createServer(criarApp({ db, pastaArquivos: pasta }));
  await new Promise((r) => servidor.listen(0, r));
  base = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(() => {
  servidor.close();
  fs.rmSync(pasta, { recursive: true, force: true });
});

async function entrar(email, senha) {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, senha }),
  });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return async (metodo, caminho, dados) => {
    const resp = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers: { Cookie: cookie, ...(dados ? { 'Content-Type': 'application/json' } : {}) },
      body: dados ? JSON.stringify(dados) : undefined,
    });
    const tipo = resp.headers.get('content-type') ?? '';
    return { status: resp.status, corpo: tipo.includes('json') ? await resp.json() : await resp.text() };
  };
}

const arquivo = (nome, tipo, conteudo) => ({ nome_arquivo: nome, tipo_mime: tipo, conteudo_base64: Buffer.from(conteudo).toString('base64') });

test('registro de nota emitida pelo XML atualiza solicitação e relatório', async () => {
  const admin = await entrar('admin@x.com', 'senha-admin');
  const empresaId = (await admin('POST', '/api/empresas', { razao_social: 'Padaria Boa', cnpj: CNPJ_EMPRESA, plano_notas: true, notas_incluidas: 1 })).corpo.id;
  const outraId = (await admin('POST', '/api/empresas', { razao_social: 'Outra', cnpj: '11444777000161' })).corpo.id;

  // Solicitação em aberto que corresponde à NFS-e (mesmo tomador e valor).
  const pedido = (await admin('POST', '/api/solicitacoes', {
    empresa_id: empresaId, tipo_nota: 'NFS-e', tomador_documento: '52998224725', tomador_nome: 'Maria Tomadora',
    descricao: 'Consultoria', valor: '2.500,00', data_competencia: '2026-10-20',
  })).corpo.id;

  // Leitura sem empresa informada: identifica pelo CNPJ do emitente e sugere a solicitação.
  let r = await admin('POST', '/api/notas/ler-xml', { conteudo_base64: Buffer.from(XML_NFSE_NACIONAL).toString('base64') });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.empresa_id, empresaId);
  assert.equal(r.corpo.sugerida_id, pedido);
  assert.deepEqual(r.corpo.avisos, []);

  // Leitura a partir do perfil de outra empresa: avisa.
  r = await admin('POST', '/api/notas/ler-xml', { conteudo_base64: Buffer.from(XML_NFSE_NACIONAL).toString('base64'), empresa_id: outraId });
  assert.match(r.corpo.avisos[0], /emitido por Padaria Boa/);

  r = await admin('POST', '/api/notas/ler-xml', { conteudo_base64: Buffer.from('<x/>').toString('base64') });
  assert.equal(r.status, 422);

  // Sem arquivos não registra.
  r = await admin('POST', '/api/notas-emitidas', { empresa_id: empresaId, numero_nota: '87', data_emissao: '2026-10-20', solicitacao_id: pedido });
  assert.equal(r.status, 400);

  // Vincula à solicitação aberta.
  r = await admin('POST', '/api/notas-emitidas', {
    empresa_id: empresaId, solicitacao_id: pedido, numero_nota: '87', data_emissao: '2026-10-20', valor: '2.500,00',
    arquivos: [arquivo('nfse-87.xml', 'application/xml', XML_NFSE_NACIONAL), arquivo('nfse-87.pdf', 'application/pdf', '%PDF-1.4')],
  });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.id, pedido);
  assert.equal(r.corpo.vinculada, true);
  r = await admin('GET', `/api/solicitacoes/${pedido}`);
  assert.equal(r.corpo.status, 'emitida');
  assert.equal(r.corpo.numero_nota, '87');
  assert.equal(r.corpo.data_emissao, '2026-10-20');
  assert.equal(r.corpo.anexos.length, 2);

  // Mesmo número de novo: recusa.
  r = await admin('POST', '/api/notas-emitidas', {
    empresa_id: empresaId, numero_nota: '87', data_emissao: '2026-10-20', tipo_nota: 'NFS-e',
    tomador_documento: '52998224725', tomador_nome: 'X', descricao: 'Y', valor: '1,00',
    arquivos: [arquivo('a.pdf', 'application/pdf', '%PDF')],
  });
  assert.equal(r.status, 409);

  // Nota sem solicitação (NF-e de novembro) entra como nova e conta no mês da emissão.
  r = await admin('POST', '/api/notas-emitidas', {
    empresa_id: empresaId, numero_nota: '4521', data_emissao: '2026-11-03', tipo_nota: 'NF-e',
    tomador_documento: '11444777000161', tomador_nome: 'Eventos & Festas Ltda', descricao: 'Kit café', valor: '1500.00',
    arquivos: [arquivo('nfe-4521.xml', 'application/xml', XML_NFE)],
  });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.vinculada, false);
  const nova = (await admin('GET', `/api/solicitacoes/${r.corpo.id}`)).corpo;
  assert.equal(nova.status, 'emitida');
  assert.equal(nova.anexos[0].nome_arquivo, 'nfe-4521.xml');

  r = await admin('GET', `/api/relatorio?empresa_id=${empresaId}`);
  assert.equal(r.corpo.empresas.length, 1);
  const e = r.corpo.empresas[0];
  assert.equal(e.notas.por_mes['2026-11'], 1);
  assert.equal(e.notas.emitidas, 2);

  // Lista de notas do perfil filtrada pelo período.
  r = await admin('GET', `/api/solicitacoes?empresa_id=${empresaId}&inicio=2026-11-01&fim=2026-11-30`);
  assert.deepEqual(r.corpo.map((s) => s.numero_nota), ['4521']);
  assert.equal(r.corpo[0].anexos, 1);
});

test('guia recalculada e multa com guia anexada', async () => {
  const admin = await entrar('admin@x.com', 'senha-admin');
  const empresaId = (await admin('GET', '/api/empresas')).corpo.find((e) => e.cnpj === CNPJ_EMPRESA).id;

  let r = await admin('POST', '/api/ocorrencias', {
    empresa_id: empresaId, tipo: 'multa', tributo: 'das', competencia: '2026-09', data: '2026-10-25',
    motivo: 'guia_apos_vencimento', causa: 'escritorio', valor: '57,30',
    arquivos: [arquivo('multa-das.pdf', 'application/pdf', '%PDF-multa')],
  });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.anexos, 1);
  const multaId = r.corpo.id;

  r = await admin('POST', '/api/ocorrencias', {
    empresa_id: empresaId, tipo: 'guia_recalculada', tributo: 'xyz', data: '2026-10-25', motivo: 'retificacao', causa: 'cliente',
  });
  assert.equal(r.status, 400, 'tributo inválido');
  r = await admin('POST', '/api/ocorrencias', {
    empresa_id: empresaId, tipo: 'guia_recalculada', data: '2026-10-25', motivo: 'retificacao', causa: 'cliente',
    arquivos: [arquivo('virus.exe', 'application/x-msdownload', 'MZ')],
  });
  assert.equal(r.status, 400, 'tipo de arquivo não permitido');

  r = await admin('GET', `/api/ocorrencias?empresa_id=${empresaId}`);
  const multa = r.corpo.find((o) => o.id === multaId);
  assert.equal(multa.tributo, 'das');
  assert.equal(multa.competencia, '2026-09');
  assert.equal(multa.anexos.length, 1);

  r = await admin('GET', `/api/ocorrencias/anexos/${multa.anexos[0].id}`);
  assert.equal(r.status, 200);
  assert.equal(r.corpo, '%PDF-multa');

  // Anexar mais um arquivo depois.
  r = await admin('POST', `/api/ocorrencias/${multaId}/anexos`, { arquivos: [arquivo('comprovante.png', 'image/png', 'PNG')] });
  assert.equal(r.status, 200);

  // Excluir a ocorrência apaga os arquivos do disco.
  const antes = fs.readdirSync(pasta).length;
  assert.equal((await admin('DELETE', `/api/ocorrencias/${multaId}`, {})).status, 200);
  assert.equal(fs.readdirSync(pasta).length, antes - 2);
  assert.equal((await admin('GET', `/api/ocorrencias/anexos/${multa.anexos[0].id}`)).status, 404);
});
