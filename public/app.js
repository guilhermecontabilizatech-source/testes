'use strict';

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

const STATUS = {
  pendente: 'Pendente',
  em_emissao: 'Em emissão',
  emitida: 'Emitida',
  rejeitada: 'Rejeitada',
  cancelada: 'Cancelada',
};

const ACOES_STATUS = {
  em_emissao: { rotulo: 'Iniciar emissão', classe: '' },
  emitida: { rotulo: 'Marcar como emitida', classe: '' },
  rejeitada: { rotulo: 'Rejeitar', classe: 'perigo' },
  pendente: { rotulo: 'Voltar para pendente', classe: 'secundario' },
  cancelada: { rotulo: 'Cancelar solicitação', classe: 'secundario' },
};

const ROTULOS_HISTORICO = {
  criada: 'Solicitação criada',
  editada: 'Solicitação alterada',
  comentario: 'Comentário',
  anexo: 'Anexo',
};

let usuario = null;
let opcoes = { canais: {}, regimes: {}, ufs: [], acesso_clientes: false, portal_clientes: false, clientes_entram: false };
const conteudo = document.getElementById('conteudo');

// Cria elementos DOM de forma segura (texto nunca é interpretado como HTML).
function h(tag, atributos = {}, ...filhos) {
  const el = document.createElement(tag);
  for (const [chave, valor] of Object.entries(atributos ?? {})) {
    if (valor === false || valor == null) continue;
    if (chave.startsWith('on')) el.addEventListener(chave.slice(2), valor);
    else if (chave === 'style' && typeof valor === 'object') {
      for (const [prop, v] of Object.entries(valor)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, v); else el.style[prop] = v;
      }
    }
    else if (valor === true) el.setAttribute(chave, '');
    else el.setAttribute(chave, valor);
  }
  for (const filho of filhos.flat(Infinity)) {
    if (filho == null || filho === false) continue;
    el.append(filho instanceof Node ? filho : document.createTextNode(String(filho)));
  }
  return el;
}

async function api(caminho, { metodo = 'GET', dados } = {}) {
  const resposta = await fetch(caminho, {
    method: metodo,
    headers: dados ? { 'Content-Type': 'application/json' } : {},
    body: dados ? JSON.stringify(dados) : undefined,
    credentials: 'same-origin',
  });
  const corpo = await resposta.json().catch(() => ({}));
  if (resposta.status === 401 && caminho !== '/api/login') {
    usuario = null;
    location.hash = '#/login';
  }
  if (!resposta.ok) throw new Error(corpo.erro || 'Falha na comunicação com o servidor.');
  return corpo;
}

const moeda = (centavos) => (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const data = (iso) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR') : '');
const dataHora = (texto) => (texto ? new Date(`${texto.replace(' ', 'T')}Z`).toLocaleString('pt-BR') : '');
function documento(d) {
  if (!d) return '';
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
}
const etiqueta = (status) => h('span', { class: 'etiqueta', style: { '--cor': `var(--${status})` } }, STATUS[status]);
const tamanho = (bytes) => (bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);

function avisar(mensagem, tipo = 'sucesso') {
  const el = document.getElementById('aviso');
  el.textContent = mensagem;
  el.className = tipo;
  el.hidden = false;
  clearTimeout(avisar.timer);
  avisar.timer = setTimeout(() => { el.hidden = true; }, 3500);
}

function dadosFormulario(form) {
  return Object.fromEntries(new FormData(form).entries());
}

// Envolve o envio de formulários: desabilita o botão e mostra erros.
function aoEnviar(acao) {
  return async (evento) => {
    evento.preventDefault();
    const form = evento.target;
    const botao = form.querySelector('button[type=submit]');
    const caixaErro = form.querySelector('.alerta.erro');
    if (botao) botao.disabled = true;
    if (caixaErro) caixaErro.remove();
    try {
      await acao(dadosFormulario(form), form);
    } catch (err) {
      form.prepend(h('div', { class: 'alerta erro' }, err.message));
    } finally {
      if (botao) botao.disabled = false;
    }
  };
}

function campo(rotulo, atributos, { inteira = false } = {}) {
  const tag = atributos.tag ?? 'input';
  const { tag: _, valor, opcoes, ...attrs } = atributos;
  let el;
  if (tag === 'select') {
    el = h('select', attrs, opcoes.map(([v, t]) => h('option', { value: v, selected: String(v) === String(valor ?? '') }, t)));
  } else if (tag === 'textarea') {
    el = h('textarea', attrs, valor ?? '');
  } else {
    el = h('input', { ...attrs, value: valor ?? null });
  }
  return h('label', { class: inteira ? 'inteira' : null }, rotulo, el);
}

// No celular as tabelas viram cartões: cada célula recebe o título da sua coluna (data-rotulo),
// mostrado pelo CSS. Vale também para tabelas montadas depois (diálogos, prévias).
function rotularTabelas(raiz) {
  for (const tabela of raiz.querySelectorAll('table:not(.manter)')) {
    const titulos = [];
    for (const th of tabela.tHead?.rows[tabela.tHead.rows.length - 1]?.cells ?? []) {
      for (let i = 0; i < th.colSpan; i++) titulos.push(th.textContent.trim());
    }
    for (const corpo of tabela.tBodies) {
      for (const linha of corpo.rows) {
        let coluna = 0;
        for (const celula of linha.cells) {
          if (!celula.hasAttribute('data-rotulo')) celula.setAttribute('data-rotulo', titulos[coluna] ?? '');
          coluna += celula.colSpan;
        }
      }
    }
  }
}
new MutationObserver(() => rotularTabelas(document)).observe(document.body, { childList: true, subtree: true });

function renderizar(...elementos) {
  conteudo.replaceChildren(...elementos.filter((el) => el != null && el !== false));
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// Telas
// ---------------------------------------------------------------------------

function telaLogin() {
  document.getElementById('topo').hidden = true;
  document.getElementById('faixa-marca').hidden = true;
  document.body.classList.add('tela-login');
  document.body.classList.remove('com-lateral');
  renderizar(h('div', { class: 'pagina-login' }, h('div', { class: 'cartao login' },
    h('img', { class: 'logo-login', src: '/marca/logo.webp', alt: 'ContabilizaTech — a sua contabilidade digital.' }),
    h('div', { class: 'faixa-marca' }),
    h('h1', {}, 'Gestão do escritório'),
    h('p', { class: 'suave' }, 'Entre com o e-mail e a senha da sua conta.'),
    h('form', {
      onsubmit: aoEnviar(async (dados) => {
        await api('/api/login', { metodo: 'POST', dados });
        await carregarUsuario();
        if (location.hash === '#/') rotear(); else location.hash = '#/';
      }),
    },
    h('div', { class: 'grade' },
      campo('E-mail', { type: 'email', name: 'email', required: true, autocomplete: 'username', autofocus: true }, { inteira: true }),
      campo('Senha', { type: 'password', name: 'senha', required: true, autocomplete: 'current-password' }, { inteira: true })),
    h('div', { class: 'acoes' }, h('button', { type: 'submit', class: 'destaque', style: { width: '100%' } }, 'Entrar'))))));
}

async function telaSolicitacoesCliente(query) {
  const filtros = new URLSearchParams(query);
  const ehEscritorio = usuario.papel === 'escritorio';
  const [resumo, lista, empresas] = await Promise.all([
    api(`/api/resumo?${new URLSearchParams([...filtros].filter(([k]) => k !== 'status'))}`),
    api(`/api/solicitacoes?${filtros}`),
    ehEscritorio ? api('/api/empresas') : Promise.resolve([]),
  ]);

  const aplicarFiltro = (chave, valor) => {
    if (valor) filtros.set(chave, valor); else filtros.delete(chave);
    location.hash = `#/?${filtros}`;
  };

  const indicadores = h('div', { class: 'indicadores' },
    Object.entries(STATUS).map(([status, rotulo]) => h('div', {
      class: 'indicador',
      style: { '--cor': `var(--${status})` },
      title: 'Filtrar por este status',
      onclick: () => aplicarFiltro('status', filtros.get('status') === status ? '' : status),
    },
    h('div', { class: 'numero' }, resumo[status].quantidade),
    h('div', { class: 'rotulo' }, rotulo, ' · ', moeda(resumo[status].total_centavos)))));

  const barraFiltros = h('form', {
    class: 'filtros',
    onsubmit: (e) => {
      e.preventDefault();
      const dados = dadosFormulario(e.target);
      const novo = new URLSearchParams();
      for (const [k, v] of Object.entries(dados)) if (v) novo.set(k, v);
      location.hash = `#/?${novo}`;
    },
  },
  ehEscritorio && campo('Empresa', {
    tag: 'select', name: 'empresa_id', valor: filtros.get('empresa_id'),
    opcoes: [['', 'Todas'], ...empresas.map((e) => [e.id, e.razao_social])],
  }),
  campo('Status', { tag: 'select', name: 'status', valor: filtros.get('status'), opcoes: [['', 'Todos'], ...Object.entries(STATUS)] }),
  campo('Competência', { type: 'month', name: 'mes', valor: filtros.get('mes') }),
  campo('Busca', { type: 'search', name: 'busca', valor: filtros.get('busca'), placeholder: 'Tomador, descrição, nº nota…' }),
  h('button', { type: 'submit', class: 'secundario' }, 'Filtrar'),
  [...filtros].length ? h('a', { href: '#/', class: 'botao secundario' }, 'Limpar') : null);

  const tabela = lista.length
    ? h('div', { class: 'tabela' }, h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, '#'),
        ehEscritorio && h('th', {}, 'Empresa'),
        h('th', {}, 'Tipo'), h('th', {}, 'Tomador'), h('th', { class: 'num' }, 'Valor'),
        h('th', {}, 'Competência'), h('th', {}, 'Status'), h('th', {}, 'Nº nota'))),
      h('tbody', {}, lista.map((s) => h('tr', { class: 'clicavel', onclick: () => { location.hash = `#/solicitacao/${s.id}`; } },
        h('td', {}, s.id),
        ehEscritorio && h('td', {}, s.empresa_nome),
        h('td', {}, s.tipo_nota),
        h('td', {}, s.tomador_nome, h('div', { class: 'suave' }, documento(s.tomador_documento))),
        h('td', { class: 'num' }, moeda(s.valor_centavos)),
        h('td', {}, data(s.data_competencia)),
        h('td', {}, etiqueta(s.status)),
        h('td', {}, s.numero_nota ?? '—'))))))
    : h('div', { class: 'cartao vazio' }, 'Nenhuma solicitação encontrada.');

  renderizar(
    h('div', { class: 'cabecalho-pagina' },
      h('h1', {}, ehEscritorio ? 'Painel de solicitações' : `Minhas solicitações — ${usuario.empresa?.razao_social ?? ''}`),
      h('div', { class: 'acoes', style: { marginTop: 0 } },
        h('a', { class: 'botao secundario', href: `/api/solicitacoes.csv?${filtros}` }, 'Exportar CSV'),
        ehEscritorio && h('button', { class: 'secundario', onclick: () => abrirDialogoNota() }, 'Registrar nota emitida (XML)'),
        h('a', { class: 'botao', href: '#/nova' }, '+ Nova solicitação'))),
    indicadores, barraFiltros, tabela);
}

async function telaFormulario(id) {
  const ehEscritorio = usuario.papel === 'escritorio';
  const [s, empresas] = await Promise.all([
    id ? api(`/api/solicitacoes/${id}`) : Promise.resolve({ tipo_nota: 'NFS-e', data_competencia: new Date().toISOString().slice(0, 10) }),
    ehEscritorio && !id ? api('/api/empresas') : Promise.resolve([]),
  ]);

  renderizar(
    h('div', { class: 'cabecalho-pagina' },
      h('h1', {}, id ? `Editar solicitação #${id}` : 'Nova solicitação de nota fiscal'),
      h('a', { href: id ? `#/solicitacao/${id}` : '#/' }, '← Voltar')),
    s.status === 'rejeitada' && h('div', { class: 'alerta erro' },
      h('strong', {}, 'Motivo da rejeição: '), s.motivo_rejeicao,
      h('div', {}, 'Corrija os dados abaixo e salve para reenviar ao escritório.')),
    h('form', {
      class: 'cartao',
      onsubmit: aoEnviar(async (dados) => {
        if (id) {
          await api(`/api/solicitacoes/${id}`, { metodo: 'PUT', dados });
          avisar('Solicitação atualizada.');
          location.hash = `#/solicitacao/${id}`;
        } else {
          const r = await api('/api/solicitacoes', { metodo: 'POST', dados });
          avisar('Solicitação enviada ao escritório!');
          location.hash = `#/solicitacao/${r.id}`;
        }
      }),
    },
    h('h2', {}, 'Dados da nota'),
    h('div', { class: 'grade' },
      ehEscritorio && !id && campo('Empresa emissora *', {
        tag: 'select', name: 'empresa_id', required: true,
        opcoes: [['', 'Selecione…'], ...empresas.filter((e) => e.ativo).map((e) => [e.id, `${e.razao_social} (${documento(e.cnpj)})`])],
      }),
      campo('Tipo de nota *', { tag: 'select', name: 'tipo_nota', valor: s.tipo_nota, opcoes: [['NFS-e', 'NFS-e (serviço)'], ['NF-e', 'NF-e (produto)']] }),
      campo('Valor (R$) *', {
        name: 'valor', required: true, inputmode: 'decimal', placeholder: '0,00',
        valor: s.valor_centavos ? (s.valor_centavos / 100).toFixed(2).replace('.', ',') : '',
      }),
      campo('Data de competência *', { type: 'date', name: 'data_competencia', required: true, valor: s.data_competencia }),
      campo('Descrição do serviço/produto *', { tag: 'textarea', name: 'descricao', required: true, maxlength: 2000, valor: s.descricao }, { inteira: true })),
    h('h2', { style: { marginTop: '24px' } }, 'Tomador (cliente que vai receber a nota)'),
    h('div', { class: 'grade' },
      campo('CPF/CNPJ *', { name: 'tomador_documento', required: true, valor: documento(s.tomador_documento), placeholder: '00.000.000/0000-00' }),
      campo('Nome / Razão social *', { name: 'tomador_nome', required: true, maxlength: 200, valor: s.tomador_nome }),
      campo('E-mail', { type: 'email', name: 'tomador_email', valor: s.tomador_email }),
      campo('Endereço', { name: 'tomador_endereco', maxlength: 300, valor: s.tomador_endereco }, { inteira: true }),
      campo('Observações para o escritório', { tag: 'textarea', name: 'observacoes', maxlength: 2000, valor: s.observacoes }, { inteira: true })),
    h('div', { class: 'acoes' },
      h('button', { type: 'submit' }, id ? 'Salvar alterações' : 'Enviar solicitação'))));
}

function lerArquivoBase64(arquivo) {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(String(leitor.result).split(',')[1]);
    leitor.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    leitor.readAsDataURL(arquivo);
  });
}

function dialogoStatus(s, destino) {
  const precisaNumero = destino === 'emitida';
  const precisaMotivo = destino === 'rejeitada' || (destino === 'cancelada' && usuario.papel === 'cliente');
  const dialogo = h('dialog', {},
    h('form', {
      onsubmit: aoEnviar(async (dados) => {
        await api(`/api/solicitacoes/${s.id}/status`, { metodo: 'POST', dados: { ...dados, status: destino } });
        dialogo.close();
        avisar(`Status alterado para "${STATUS[destino]}".`);
        rotear();
      }),
    },
    h('h2', {}, ACOES_STATUS[destino].rotulo),
    h('div', { class: 'grade' },
      precisaNumero && campo('Número da nota *', { name: 'numero_nota', required: true, maxlength: 50 }, { inteira: true }),
      campo(precisaMotivo ? 'Motivo *' : 'Mensagem (opcional)', { tag: 'textarea', name: 'mensagem', required: precisaMotivo, maxlength: 2000 }, { inteira: true })),
    precisaNumero && h('p', { class: 'suave' }, 'Depois, anexe o PDF e/ou XML da nota para o cliente baixar.'),
    h('div', { class: 'acoes' },
      h('button', { type: 'submit', class: ACOES_STATUS[destino].classe }, 'Confirmar'),
      h('button', { type: 'button', class: 'secundario', onclick: () => dialogo.close() }, 'Voltar'))));
  dialogo.addEventListener('close', () => dialogo.remove());
  document.body.append(dialogo);
  dialogo.showModal();
}

async function telaDetalhe(id) {
  const s = await api(`/api/solicitacoes/${id}`);
  const ehEscritorio = usuario.papel === 'escritorio';

  const item = (rotulo, valor, inteira = false) => h('div', { class: inteira ? 'inteira' : null }, h('dt', {}, rotulo), h('dd', {}, valor || '—'));

  const formAnexo = s.status !== 'cancelada' && h('form', {
    onsubmit: aoEnviar(async (_, form) => {
      const arquivo = form.querySelector('input[type=file]').files[0];
      if (!arquivo) throw new Error('Selecione um arquivo.');
      if (arquivo.size > 10 * 1024 * 1024) throw new Error('Arquivo maior que 10 MB.');
      const tipo = arquivo.type || (arquivo.name.toLowerCase().endsWith('.xml') ? 'application/xml' : '');
      await api(`/api/solicitacoes/${id}/anexos`, {
        metodo: 'POST',
        dados: { nome_arquivo: arquivo.name, tipo_mime: tipo, conteudo_base64: await lerArquivoBase64(arquivo) },
      });
      avisar('Arquivo anexado.');
      rotear();
    }),
  },
  h('div', { class: 'filtros' },
    h('input', { type: 'file', accept: '.pdf,.xml,.png,.jpg,.jpeg' }),
    h('button', { type: 'submit', class: 'secundario' }, 'Anexar')));

  renderizar(
    h('div', { class: 'cabecalho-pagina' },
      h('h1', {}, s.status === 'emitida' ? `Nota nº ${s.numero_nota} ` : `Solicitação #${s.id} `, etiqueta(s.status)),
      h('a', { href: ehEscritorio ? '#/notas' : '#/' }, '← Voltar para a lista')),
    s.status === 'rejeitada' && h('div', { class: 'alerta erro' }, h('strong', {}, 'Rejeitada: '), s.motivo_rejeicao,
      !ehEscritorio && h('div', {}, 'Clique em "Corrigir e reenviar" para ajustar os dados.')),
    s.status === 'emitida' && !s.anexos.length && h('div', { class: 'alerta info' }, 'Esta nota ainda não tem o PDF/XML anexado.'),
    h('div', { class: 'colunas' },
      h('div', {},
        h('div', { class: 'cartao' },
          h('h2', {}, 'Dados da nota'),
          h('dl', { class: 'detalhes' },
            item('Empresa emissora', `${s.empresa_nome} (${documento(s.empresa_cnpj)})`),
            item('Tipo', s.tipo_nota),
            item('Valor', s.valor_centavos ? moeda(s.valor_centavos) : ''),
            item('Nº da nota', s.numero_nota),
            item('Data de emissão', data(s.data_emissao)),
            item('Pedido recebido por', s.canal_pedido ? rotuloComOutro(opcoes.canais, s.canal_pedido, s.canal_outro) : ''),
            item('Data do pedido', data(s.data_pedido)),
            item('Registrada por', s.responsavel_nome),
            item('Descrição', s.descricao, true))),
        h('div', { class: 'cartao' },
          h('h2', {}, 'Tomador'),
          h('dl', { class: 'detalhes' },
            item('Nome / Razão social', s.tomador_nome ?? ''),
            item('CPF/CNPJ', documento(s.tomador_documento)),
            item('E-mail', s.tomador_email),
            item('Endereço', s.tomador_endereco, true),
            item('Observações', s.observacoes, true))),
        h('div', { class: 'cartao' },
          h('h2', {}, 'Ações'),
          h('div', { class: 'acoes', style: { marginTop: 0 } },
            ehEscritorio && s.status === 'emitida' && [
              h('button', { onclick: () => abrirDialogoNota(null, s) }, 'Editar nota'),
              h('button', {
                class: 'secundario',
                onclick: async () => {
                  try {
                    if (await excluirNota(s)) location.hash = '#/notas';
                  } catch (err) {
                    avisar(err.message, 'erro');
                  }
                },
              }, 'Excluir nota')],
            s.editavel && h('a', { class: 'botao', href: `#/solicitacao/${s.id}/editar` },
              s.status === 'rejeitada' ? 'Corrigir e reenviar' : 'Editar'),
            s.transicoes.map((destino) => h('button', {
              class: ACOES_STATUS[destino].classe,
              onclick: () => dialogoStatus(s, destino),
            }, ACOES_STATUS[destino].rotulo)),
            !s.editavel && !s.transicoes.length && !(ehEscritorio && s.status === 'emitida') && h('span', { class: 'suave' }, 'Nenhuma ação disponível.')))),
      h('div', {},
        h('div', { class: 'cartao' },
          h('h2', {}, 'Anexos'),
          s.anexos.length
            ? h('ul', { class: 'anexos' }, s.anexos.map((a) => h('li', {},
              h('a', { href: `/api/anexos/${a.id}` }, a.nome_arquivo),
              h('div', { class: 'suave' }, `${tamanho(a.tamanho)} · ${a.enviado_por_nome ?? ''} · ${dataHora(a.criado_em)}`))))
            : h('p', { class: 'suave' }, 'Nenhum arquivo anexado.'),
          formAnexo),
        h('div', { class: 'cartao' },
          h('h2', {}, ehEscritorio ? 'Histórico e observações' : 'Histórico e mensagens'),
          h('ul', { class: 'linha-tempo' }, s.historico.map((ev) => h('li', {},
            h('div', {}, h('strong', {}, ev.acao.startsWith('status:') ? `Status: ${STATUS[ev.acao.slice(7)]}` : ROTULOS_HISTORICO[ev.acao] ?? ev.acao)),
            h('div', { class: 'quando' }, `${ev.usuario_nome ?? 'Sistema'} · ${dataHora(ev.criado_em)}`),
            ev.mensagem && h('div', { class: 'msg' }, ev.mensagem)))),
          h('form', {
            style: { marginTop: '12px' },
            onsubmit: aoEnviar(async (dados) => {
              await api(`/api/solicitacoes/${id}/comentarios`, { metodo: 'POST', dados });
              rotear();
            }),
          },
          campo(ehEscritorio ? 'Adicionar observação' : 'Enviar mensagem', { tag: 'textarea', name: 'mensagem', required: true, maxlength: 2000, placeholder: 'Escreva uma observação…' }),
          h('div', { class: 'acoes', style: { marginTop: '8px' } }, h('button', { type: 'submit', class: 'secundario' }, 'Enviar')))))));
}

function abrirDialogo(...conteudoDialogo) {
  const dialogo = h('dialog', {}, ...conteudoDialogo);
  dialogo.addEventListener('close', () => dialogo.remove());
  document.body.append(dialogo);
  dialogo.showModal();
  return dialogo;
}

const rotuloRegime = (e) => (e.regime ? rotuloComOutro(opcoes.regimes, e.regime, e.regime_outro) : null);

async function abrirFormularioEmpresa(e = {}) {
  const equipe = await equipeDoEscritorio();
  const regime = campo('Regime tributário', {
    tag: 'select', name: 'regime', valor: e.regime ?? '', opcoes: [['', '— não informado —'], ...Object.entries(opcoes.regimes)],
  });
  const dialogo = abrirDialogo(h('form', {
    onsubmit: aoEnviar(async (dados) => {
      const corpo = { ...dados, ativo: dados.ativo === '1', plano_notas: dados.plano_notas === '1' };
      if (e.id) await api(`/api/empresas/${e.id}`, { metodo: 'PUT', dados: corpo });
      else await api('/api/empresas', { metodo: 'POST', dados: corpo });
      dialogo.close();
      avisar('Cliente salvo.');
      rotear();
    }),
  },
  h('h2', {}, e.id ? 'Editar cliente' : 'Novo cliente'),
  h('div', { class: 'grade' },
    campo('Razão social ou nome *', { name: 'razao_social', required: true, valor: e.razao_social }, { inteira: true }),
    campo('Nome fantasia', { name: 'nome_fantasia', maxlength: 200, valor: e.nome_fantasia }),
    campo('CNPJ ou CPF *', { name: 'cnpj', required: true, valor: documento(e.cnpj), placeholder: 'CPF para autônomo / pessoa física' }),
    comOutro(regime, 'regime_outro', { valor: e.regime_outro ?? '', rotulo: 'Qual regime' }),
    campo('Situação', { tag: 'select', name: 'ativo', valor: e.ativo === 0 ? '0' : '1', opcoes: [['1', 'Ativo'], ['0', 'Inativo']] }),
    campo('Responsável no escritório', { tag: 'select', name: 'responsavel_id', valor: e.responsavel_id ?? '', opcoes: [['', '—'], ...equipe.map((u) => [u.id, u.nome])] }),
    campo('Honorário mensal (R$)', { name: 'honorario', inputmode: 'decimal', placeholder: '0,00', valor: reaisCampo(e.honorario_centavos) }),
    campo('Início do contrato', { type: 'date', name: 'data_contrato', valor: e.data_contrato })),
  h('h3', {}, 'Contato e endereço'),
  h('div', { class: 'grade' },
    campo('E-mail', { type: 'email', name: 'email', valor: e.email }),
    campo('Telefone', { name: 'telefone', valor: e.telefone }),
    campo('Endereço', { name: 'endereco', maxlength: 300, valor: e.endereco }, { inteira: true }),
    campo('Cidade', { name: 'cidade', maxlength: 100, valor: e.cidade }),
    campo('UF', { tag: 'select', name: 'uf', valor: e.uf ?? '', opcoes: [['', '—'], ...opcoes.ufs.map((uf) => [uf, uf])] })),
  h('h3', {}, 'Plano de emissão de notas'),
  h('div', { class: 'grade' },
    campo('Tem plano de notas?', { tag: 'select', name: 'plano_notas', valor: e.plano_notas ? '1' : '0', opcoes: [['0', 'Não'], ['1', 'Sim']] }),
    campo('Notas incluídas por mês', { type: 'number', name: 'notas_incluidas', min: 0, step: 1, valor: e.notas_incluidas ?? '', placeholder: 'Deixe vazio se não houver limite' }),
    campo('Nome do plano', { name: 'plano_nome', maxlength: 100, valor: e.plano_nome, placeholder: 'Ex.: Simples Nacional — Essencial' }, { inteira: true })),
  h('div', { class: 'grade', style: { marginTop: '14px' } },
    campo('Observações', { tag: 'textarea', name: 'observacoes', maxlength: 2000, valor: e.observacoes }, { inteira: true })),
  h('div', { class: 'acoes' },
    h('button', { type: 'submit' }, 'Salvar'),
    h('button', { type: 'button', class: 'secundario', onclick: () => dialogo.close() }, 'Cancelar'))));
  dialogo.classList.add('largo');
}

// Exclusão de empresa: mostra o que será apagado junto e, se houver registros, exige digitar EXCLUIR.
async function abrirExclusaoEmpresa(e, { aoExcluir } = {}) {
  const dep = await api(`/api/empresas/${e.id}/dependencias`);
  const temDados = dep.notas || dep.ocorrencias || dep.usuarios;
  const dialogo = abrirDialogo(h('form', {
    onsubmit: aoEnviar(async (dados) => {
      await api(`/api/empresas/${e.id}`, { metodo: 'DELETE', dados: { confirmacao: dados.confirmacao ?? '' } });
      dialogo.close();
      avisar(`${e.razao_social} excluída.`);
      if (aoExcluir) aoExcluir(); else rotear();
    }),
  },
  h('h2', {}, 'Excluir empresa'),
  h('p', {}, h('strong', {}, e.razao_social), ` · CNPJ ${documento(e.cnpj)}`),
  temDados
    ? h('div', { class: 'alerta erro' },
      h('strong', {}, 'Também serão apagados, sem possibilidade de desfazer:'),
      h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px' } },
        dep.notas ? h('li', {}, `${dep.notas} nota(s) fiscal(is)`) : null,
        dep.ocorrencias ? h('li', {}, `${dep.ocorrencias} guia(s) recalculada(s)/multa(s)`) : null,
        dep.arquivos ? h('li', {}, `${dep.arquivos} arquivo(s) anexado(s)`) : null,
        dep.usuarios ? h('li', {}, `${dep.usuarios} acesso(s) de cliente`) : null))
    : h('p', { class: 'suave' }, 'Esta empresa não tem notas nem ocorrências registradas.'),
  temDados ? h('p', { class: 'suave' },
    'Se a empresa só deixou de ser cliente, prefira ', h('strong', {}, 'Editar → Situação: Inativa'),
    ': ela some das listas de lançamento, mas o histórico continua no relatório.') : null,
  temDados ? campo('Para confirmar, digite EXCLUIR', { name: 'confirmacao', required: true, autocomplete: 'off', pattern: 'EXCLUIR' }) : null,
  h('div', { class: 'acoes' },
    h('button', { type: 'submit', class: 'perigo' }, 'Excluir empresa'),
    h('button', { type: 'button', class: 'secundario', onclick: () => dialogo.close() }, 'Cancelar'))));
}

async function telaEmpresas() {
  const empresas = await api('/api/empresas');
  const podeLote = Boolean(usuario.admin);
  const selecionadas = new Set();
  const busca = h('input', { type: 'search', placeholder: 'Buscar por nome, CNPJ/CPF ou responsável…', style: { minWidth: '280px' } });
  const filtroRegime = h('select', { title: 'Regime tributário' },
    h('option', { value: '' }, 'Todos os regimes'),
    Object.entries(opcoes.regimes).map(([v, t]) => h('option', { value: v }, t)),
    h('option', { value: '-' }, 'Regime não informado'));
  const filtroSituacao = h('select', { title: 'Situação' },
    h('option', { value: '' }, 'Ativos e inativos'), h('option', { value: '1' }, 'Só ativos'), h('option', { value: '0' }, 'Só inativos'));
  const contagem = h('span', { class: 'suave' });
  const marcarTodas = h('input', { type: 'checkbox', title: 'Selecionar todas as visíveis' });
  const contador = h('span', { class: 'suave' });
  const botaoLote = h('button', { class: 'perigo', onclick: () => abrirExclusaoLote(empresas.filter((e) => selecionadas.has(e.id))) });
  const barraLote = h('div', { class: 'barra-lote', hidden: true }, contador, botaoLote,
    h('button', { class: 'secundario', onclick: () => { selecionadas.clear(); atualizarSelecao(); } }, 'Limpar seleção'));

  const linhas = empresas.map((e) => {
    const marcar = podeLote ? h('input', {
      type: 'checkbox',
      onchange: (ev) => { if (ev.target.checked) selecionadas.add(e.id); else selecionadas.delete(e.id); atualizarSelecao(); },
    }) : null;
    const tr = h('tr', {},
      podeLote && h('td', {}, marcar),
      h('td', {}, h('a', { href: `#/empresa/${e.id}` }, e.razao_social), e.nome_fantasia ? h('div', { class: 'suave' }, e.nome_fantasia) : null,
        e.ativo ? null : h('div', {}, h('span', { class: 'etiqueta', style: { '--cor': 'var(--cancelada)' } }, 'Inativo'))),
      h('td', { style: { whiteSpace: 'nowrap' } }, documento(e.cnpj)),
      h('td', {}, rotuloRegime(e) ?? h('span', { class: 'suave' }, '—')),
      h('td', {}, descricaoPlano(e)),
      h('td', { class: 'num' }, e.honorario_centavos == null ? '—' : moeda(e.honorario_centavos)),
      h('td', {}, e.responsavel_nome ?? h('span', { class: 'suave' }, '—')),
      h('td', {}, e.email ?? '', h('div', { class: 'suave' }, e.telefone ?? '')),
      h('td', {}, h('div', { class: 'acoes', style: { marginTop: 0, flexWrap: 'nowrap' } },
        h('button', { class: 'secundario', onclick: () => abrirFormularioEmpresa(e) }, 'Editar'),
        h('button', { class: 'secundario', title: 'Excluir empresa', onclick: () => abrirExclusaoEmpresa(e) }, 'Excluir'))));
    const textoBusca = normalizarBusca(`${e.razao_social} ${e.nome_fantasia ?? ''} ${e.cnpj} ${documento(e.cnpj)} ${e.responsavel_nome ?? ''}`);
    return { e, tr, marcar, textoBusca };
  });

  const visiveis = () => linhas.filter((l) => !l.tr.hidden);
  function atualizarSelecao() {
    for (const l of linhas) if (l.marcar) l.marcar.checked = selecionadas.has(l.e.id);
    const vis = visiveis();
    marcarTodas.checked = vis.length > 0 && vis.every((l) => selecionadas.has(l.e.id));
    barraLote.hidden = selecionadas.size === 0;
    contador.textContent = `${selecionadas.size} empresa(s) selecionada(s)`;
    botaoLote.textContent = `Excluir ${selecionadas.size} selecionada(s)`;
  }
  marcarTodas.addEventListener('change', () => {
    for (const l of visiveis()) if (marcarTodas.checked) selecionadas.add(l.e.id); else selecionadas.delete(l.e.id);
    atualizarSelecao();
  });
  function filtrar() {
    const termo = normalizarBusca(busca.value);
    for (const l of linhas) {
      const regimeOk = !filtroRegime.value || (filtroRegime.value === '-' ? !l.e.regime : l.e.regime === filtroRegime.value);
      const situacaoOk = !filtroSituacao.value || String(l.e.ativo) === filtroSituacao.value;
      l.tr.hidden = !regimeOk || !situacaoOk || (Boolean(termo) && !l.textoBusca.includes(termo));
    }
    const n = visiveis().length;
    contagem.textContent = n === empresas.length ? `${n} cliente(s)` : `${n} de ${empresas.length} cliente(s)`;
    atualizarSelecao();
  }
  busca.addEventListener('input', filtrar);
  filtroRegime.addEventListener('change', filtrar);
  filtroSituacao.addEventListener('change', filtrar);
  filtrar();

  const cabecalho = ['Cliente', 'CNPJ/CPF', 'Regime', 'Plano de notas', 'Honorário', 'Responsável', 'Contato', ''];
  renderizar(
    h('div', { class: 'cabecalho-pagina' },
      h('h1', {}, 'Clientes'),
      h('div', { class: 'acoes', style: { marginTop: 0 } },
        h('button', { class: 'secundario', onclick: abrirImportacao }, 'Importar planilha ou PDF'),
        h('button', { onclick: () => abrirFormularioEmpresa() }, '+ Novo cliente'))),
    empresas.length
      ? h('div', {},
        h('div', { class: 'filtros' }, busca, filtroRegime, filtroSituacao, contagem,
          podeLote && h('span', { class: 'suave' }, 'Marque as caixas para excluir várias de uma vez.')),
        barraLote,
        h('div', { class: 'tabela' }, h('table', {},
          h('thead', {}, h('tr', {},
            podeLote && h('th', {}, marcarTodas),
            cabecalho.map((t) => h('th', { class: t === 'Honorário' ? 'num' : null }, t)))),
          h('tbody', {}, linhas.map((l) => l.tr)))))
      : h('div', { class: 'cartao vazio' }, 'Cadastre o primeiro cliente ou importe uma planilha para começar.'));
}

const normalizarBusca = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// Exclusão em lote (administradores): prévia do que será apagado e confirmação digitando EXCLUIR.
async function abrirExclusaoLote(empresas) {
  const ids = empresas.map((e) => e.id);
  let previa;
  try {
    previa = await api('/api/empresas/excluir-lote/previa', { metodo: 'POST', dados: { ids } });
  } catch (err) {
    avisar(err.message, 'erro');
    return;
  }
  const mostrar = empresas.slice(0, 8);
  const dialogo = abrirDialogo(h('form', {
    onsubmit: aoEnviar(async (dados) => {
      const r = await api('/api/empresas/excluir-lote', { metodo: 'POST', dados: { ids, confirmacao: dados.confirmacao } });
      dialogo.close();
      avisar(`${r.empresas} empresa(s) excluída(s).`);
      rotear();
    }),
  },
  h('h2', {}, `Excluir ${empresas.length} empresa(s)`),
  h('ul', { style: { margin: '0 0 12px', paddingLeft: '18px' } },
    mostrar.map((e) => h('li', {}, e.razao_social, h('span', { class: 'suave' }, ` · ${documento(e.cnpj)}`))),
    empresas.length > mostrar.length ? h('li', { class: 'suave' }, `e mais ${empresas.length - mostrar.length}…`) : null),
  h('div', { class: 'alerta erro' },
    h('strong', {}, 'Será apagado, sem possibilidade de desfazer:'),
    h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px' } },
      h('li', {}, `${previa.empresas} empresa(s)`),
      h('li', {}, `${previa.notas} nota(s) fiscal(is)`),
      h('li', {}, `${previa.ocorrencias} guia(s) recalculada(s)/multa(s)`),
      h('li', {}, `${previa.arquivos} arquivo(s) anexado(s)`),
      previa.usuarios ? h('li', {}, `${previa.usuarios} acesso(s) de cliente`) : null)),
  h('p', { class: 'suave' }, 'O backup da madrugada guarda os dados até ontem; o que foi lançado hoje não tem cópia.'),
  campo('Para confirmar, digite EXCLUIR', { name: 'confirmacao', required: true, autocomplete: 'off', pattern: 'EXCLUIR' }),
  h('div', { class: 'acoes' },
    h('button', { type: 'submit', class: 'perigo' }, `Excluir ${empresas.length} empresa(s)`),
    h('button', { type: 'button', class: 'secundario', onclick: () => dialogo.close() }, 'Cancelar'))));
}

const SITUACAO_IMPORTACAO = {
  nova: { rotulo: 'Nova', cor: 'var(--emitida)' },
  existente: { rotulo: 'Já cadastrada', cor: 'var(--em_emissao)' },
  erro: { rotulo: 'Com erro', cor: 'var(--rejeitada)' },
};

// Importação de empresas: o arquivo é analisado no servidor e o usuário confere antes de gravar.
function abrirImportacao() {
  const inputArquivo = h('input', { type: 'file', accept: '.xlsx,.csv,.pdf' });
  const resultado = h('div', {});
  const dialogo = abrirDialogo(
    h('h2', {}, 'Importar empresas'),
    h('p', { class: 'suave' },
      'Envie uma planilha (.xlsx ou .csv) ou um PDF com a relação de clientes. O sistema reconhece as colunas ',
      'CNPJ, razão social, e-mail, telefone, plano, notas incluídas e honorário. Nada é gravado antes da sua confirmação. ',
      h('a', { href: '/api/empresas/modelo.csv' }, 'Baixar planilha modelo')),
    h('label', {}, 'Arquivo', inputArquivo),
    resultado,
    h('div', { class: 'acoes' }, h('button', { type: 'button', class: 'secundario', onclick: () => dialogo.close() }, 'Fechar')));
  dialogo.classList.add('extra-largo');

  inputArquivo.addEventListener('change', async () => {
    const arquivo = inputArquivo.files[0];
    if (!arquivo) return;
    resultado.replaceChildren(h('p', { class: 'suave' }, 'Lendo o arquivo…'));
    try {
      if (arquivo.size > 10 * 1024 * 1024) throw new Error('Arquivo maior que 10 MB.');
      const analise = await api('/api/empresas/importar/analisar', {
        metodo: 'POST',
        dados: { nome_arquivo: arquivo.name, conteudo_base64: await lerArquivoBase64(arquivo) },
      });
      mostrarAnalise(analise);
    } catch (err) {
      resultado.replaceChildren(h('div', { class: 'alerta erro' }, err.message));
    }
  });

  function mostrarAnalise(analise) {
    const conta = (sit) => analise.empresas.filter((e) => e.situacao === sit).length;
    const caixaAtualizar = h('input', { type: 'checkbox' });
    const marcadores = new Map();
    const botao = h('button', { type: 'button' });
    const atualizarBotao = () => {
      const n = [...marcadores.values()].filter((c) => c.checked).length;
      botao.textContent = `Importar ${n} empresa(s)`;
      botao.disabled = n === 0;
    };
    caixaAtualizar.addEventListener('change', () => {
      for (const [e, c] of marcadores) if (e.situacao === 'existente') c.checked = caixaAtualizar.checked;
      atualizarBotao();
    });

    const linhas = analise.empresas.map((e) => {
      const marcar = e.situacao !== 'erro'
        ? h('input', { type: 'checkbox', checked: e.situacao === 'nova', onchange: atualizarBotao })
        : null;
      if (marcar) marcadores.set(e, marcar);
      const plano = e.plano_informado
        ? (e.plano_notas ? `${e.plano_nome || 'Com plano'}${e.notas_incluidas != null ? ` · ${e.notas_incluidas}/mês` : ''}` : 'Sem plano')
        : '—';
      return h('tr', {},
        h('td', {}, marcar),
        h('td', { class: 'suave' }, e.linha ?? '—'),
        h('td', {}, documento(e.cnpj) || '—'),
        h('td', {}, e.razao_social || '—'),
        h('td', {}, e.email ?? '', e.telefone ? h('div', { class: 'suave' }, e.telefone) : null),
        h('td', {}, plano),
        h('td', { class: 'num' }, e.honorario_centavos == null ? '—' : moeda(e.honorario_centavos)),
        h('td', {}, h('span', { class: 'etiqueta', style: { '--cor': SITUACAO_IMPORTACAO[e.situacao].cor } }, SITUACAO_IMPORTACAO[e.situacao].rotulo),
          e.mensagem ? h('div', { class: 'suave' }, e.mensagem) : null));
    });

    botao.addEventListener('click', async () => {
      const escolhidas = [...marcadores].filter(([, c]) => c.checked).map(([e]) => e);
      botao.disabled = true;
      try {
        const r = await api('/api/empresas/importar', {
          metodo: 'POST',
          dados: { empresas: escolhidas, atualizar_existentes: caixaAtualizar.checked },
        });
        dialogo.close();
        const partes = [`${r.criadas} empresa(s) criada(s)`];
        if (r.atualizadas) partes.push(`${r.atualizadas} atualizada(s)`);
        if (r.erros.length) partes.push(`${r.erros.length} com erro`);
        avisar(partes.join(', ') + '.', r.erros.length ? 'erro' : 'sucesso');
        rotear();
      } catch (err) {
        avisar(err.message, 'erro');
        atualizarBotao();
      }
    });

    resultado.replaceChildren(
      h('div', { class: 'alerta info' },
        `${analise.empresas.length} linha(s) encontradas: ${conta('nova')} nova(s), ${conta('existente')} já cadastrada(s), ${conta('erro')} com erro.`,
        h('div', { class: 'peq' }, analise.colunas_reconhecidas.length
          ? `Colunas reconhecidas: ${analise.colunas_reconhecidas.join(', ')}.`
          : 'Nenhum cabeçalho reconhecido: CNPJ e nome foram identificados pelo conteúdo de cada linha. Confira com atenção.')),
      conta('existente') ? h('label', { class: 'checkbox' }, caixaAtualizar, 'Atualizar os dados das empresas já cadastradas (só os campos preenchidos no arquivo)') : null,
      h('div', { class: 'tabela tabela-rolagem' }, h('table', {},
        h('thead', {}, h('tr', {}, ['', 'Linha', 'CNPJ', 'Razão social', 'Contato', 'Plano', 'Honorário', 'Situação'].map((t) => h('th', { class: t === 'Honorário' ? 'num' : null }, t)))),
        h('tbody', {}, linhas))),
      h('div', { class: 'acoes' }, botao));
    atualizarBotao();
  }
}

function descricaoPlano(e) {
  if (!e.plano_notas) return h('span', { class: 'suave' }, 'Sem plano');
  const limite = e.notas_incluidas == null ? 'sem limite' : `${e.notas_incluidas} notas/mês`;
  return [e.plano_nome || 'Com plano', h('div', { class: 'suave' }, limite)];
}

const hoje = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const PERIODO_PADRAO = { inicio: '2026-10-01', fim: '2026-12-31' };
const nomeMes = (m) => new Date(`${m}-15T12:00:00`).toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }).replace('. de ', '/').replace(' de ', '/');

function filtrosNaUrl(rota, dados) {
  const novo = new URLSearchParams();
  for (const [k, v] of Object.entries(dados)) if (v) novo.set(k, v);
  location.hash = `#/${rota}?${novo}`;
}

const ehXml = (arquivo) => /xml/.test(arquivo.type) || /\.xml$/i.test(arquivo.name);

// Lê os arquivos escolhidos num <input type=file> no formato que a API espera.
async function lerArquivosSelecionados(input) {
  const arquivos = [...input.files];
  for (const a of arquivos) if (a.size > 10 * 1024 * 1024) throw new Error(`Arquivo maior que 10 MB: ${a.name}`);
  return Promise.all(arquivos.map(async (a) => ({
    nome_arquivo: a.name,
    tipo_mime: a.type || (ehXml(a) ? 'application/xml' : ''),
    conteudo_base64: await lerArquivoBase64(a),
  })));
}

let opcoesOcorrencia = null;
async function obterOpcoesOcorrencia() {
  opcoesOcorrencia ??= await api('/api/ocorrencias/opcoes');
  return opcoesOcorrencia;
}

const ROTULO_ACAO_OCORRENCIA = { guia_recalculada: 'Registrar guia recalculada', multa: 'Registrar multa' };

// Formulário de guia recalculada / multa, com anexo da guia. Usado na tela de
// ocorrências, no painel e no perfil do cliente.
function formularioOcorrencia({ opcoes: op, empresas, empresaFixa = null, tipoFixo = null, aoSalvar, classe = null }) {
  const motivosDe = (tipo) => [['', 'Selecione…'], ...Object.entries(op.motivos[tipo])];
  const tipoInicial = tipoFixo ?? 'multa';
  const campoMotivo = campo('Motivo *', { tag: 'select', name: 'motivo', required: true, opcoes: motivosDe(tipoInicial) });
  const rotuloValor = (tipo) => (tipo === 'multa' ? 'Valor da multa (R$)' : 'Acréscimo pago — juros/multa (R$)');
  const campoValor = campo(rotuloValor(tipoInicial), { name: 'valor', inputmode: 'decimal', placeholder: '0,00' });
  const rotuloArquivo = (tipo) => (tipo === 'multa' ? 'Guia / notificação da multa (PDF ou imagem)' : 'Guia recalculada (PDF ou imagem)');
  const inputArquivo = h('input', { type: 'file', name: 'arquivos', multiple: true, accept: '.pdf,.png,.jpg,.jpeg,.xml' });
  const campoArquivo = h('label', { class: 'inteira' }, rotuloArquivo(tipoInicial), inputArquivo);
  const trocarTipo = (tipo) => {
    const select = campoMotivo.querySelector('select');
    select.replaceChildren(...motivosDe(tipo).map(([v, t]) => h('option', { value: v }, t)));
    select.dispatchEvent(new Event('change'));
    campoValor.firstChild.textContent = rotuloValor(tipo);
    campoArquivo.firstChild.textContent = rotuloArquivo(tipo);
  };

  const campoTipo = tipoFixo
    ? h('input', { type: 'hidden', name: 'tipo', value: tipoFixo })
    : (() => {
      const c = campo('Tipo *', { tag: 'select', name: 'tipo', required: true, valor: tipoInicial, opcoes: Object.entries(op.tipos) });
      c.querySelector('select').addEventListener('change', (ev) => trocarTipo(ev.target.value));
      return c;
    })();
  const campoEmpresa = empresaFixa
    ? h('input', { type: 'hidden', name: 'empresa_id', value: empresaFixa.id })
    : campo('Empresa *', { tag: 'select', name: 'empresa_id', required: true, opcoes: [['', 'Selecione…'], ...empresas.filter((e) => e.ativo).map((e) => [e.id, e.razao_social])] });

  return h('form', {
    class: classe,
    onsubmit: aoEnviar(async (dados, f) => {
      delete dados.arquivos;
      const arquivos = await lerArquivosSelecionados(inputArquivo);
      await api('/api/ocorrencias', { metodo: 'POST', dados: { ...dados, arquivos } });
      avisar(`${op.tipos[dados.tipo]} registrada${arquivos.length ? ` com ${arquivos.length} arquivo(s)` : ''}.`);
      f.reset();
      for (const s of f.querySelectorAll('select')) s.dispatchEvent(new Event('change'));
      aoSalvar?.();
    }),
  },
  h('div', { class: 'grade' },
    campoEmpresa,
    campoTipo,
    campoArquivo,
    comOutro(campo('Tributo', { tag: 'select', name: 'tributo', opcoes: [['', 'Selecione…'], ...Object.entries(op.tributos)] }),
      'tributo_outro', { rotulo: 'Qual tributo?' }),
    campo('Competência', { type: 'month', name: 'competencia' }),
    campo('Data *', { type: 'date', name: 'data', required: true, valor: hoje() }),
    comOutro(campoMotivo, 'motivo_outro', { rotulo: 'Descreva o motivo' }),
    comOutro(campo('Causa *', { tag: 'select', name: 'causa', required: true, opcoes: [['', 'Selecione…'], ...Object.entries(op.causas)] }),
      'causa_outro', { rotulo: 'Descreva a causa' }),
    campoValor,
    campo('Observação', { name: 'descricao', maxlength: 500, placeholder: 'Ex.: cliente avisou do pagamento só no dia 25' }, { inteira: true })),
  h('div', { class: 'acoes' }, h('button', { type: 'submit' }, tipoFixo ? ROTULO_ACAO_OCORRENCIA[tipoFixo] : 'Registrar')));
}

async function abrirDialogoOcorrencia(tipo, empresa = null) {
  const [op, empresas] = await Promise.all([obterOpcoesOcorrencia(), empresa ? [] : api('/api/empresas')]);
  const dialogo = abrirDialogo(
    h('h2', {}, `${ROTULO_ACAO_OCORRENCIA[tipo]}${empresa ? ` — ${empresa.razao_social}` : ''}`),
    formularioOcorrencia({ opcoes: op, empresas, empresaFixa: empresa, tipoFixo: tipo, aoSalvar: () => { dialogo.close(); rotear(); } }),
    h('div', { class: 'acoes' }, h('button', { type: 'button', class: 'secundario', onclick: () => dialogo.close() }, 'Fechar')));
  dialogo.classList.add('largo');
}

// Registro (ou edição) de nota emitida. Com XML, os dados são lidos automaticamente.
async function abrirDialogoNota(empresaFixa = null, nota = null) {
  const editando = Boolean(nota);
  const empresas = empresaFixa || editando ? [] : (await api('/api/empresas')).filter((e) => e.ativo);
  const inputArquivos = h('input', { type: 'file', multiple: true, accept: '.xml,.pdf' });
  const caixaLeitura = h('div', {});
  const selectEmpresa = empresaFixa || editando
    ? h('input', { type: 'hidden', name: 'empresa_id', value: empresaFixa?.id ?? nota.empresa_id })
    : h('select', { name: 'empresa_id', required: true }, h('option', { value: '' }, 'Selecione… (ou anexe o XML)'),
      empresas.map((e) => h('option', { value: e.id }, e.razao_social)));
  const selectVinculo = h('select', { name: 'solicitacao_id' });
  const campoVinculo = h('label', { class: 'inteira', hidden: true }, 'Atende a qual solicitação em aberto?', selectVinculo);
  const v = (nome) => nota?.[nome] ?? '';

  const maisDados = h('details', { class: 'mais-dados', open: editando && Boolean(nota.tomador_nome || nota.tomador_documento || nota.descricao) },
    h('summary', {}, 'Tomador e descrição (opcional)'),
    h('div', { class: 'grade' },
      campo('Tipo de nota', { tag: 'select', name: 'tipo_nota', valor: v('tipo_nota'), opcoes: [['', '—'], ['NFS-e', 'NFS-e (serviço)'], ['NF-e', 'NF-e (produto)']] }),
      campo('CPF/CNPJ do tomador', { name: 'tomador_documento', valor: documento(nota?.tomador_documento) }),
      campo('Nome do tomador', { name: 'tomador_nome', maxlength: 200, valor: v('tomador_nome') }),
      campo('E-mail do tomador', { type: 'email', name: 'tomador_email', valor: v('tomador_email') }),
      campo('Descrição', { tag: 'textarea', name: 'descricao', maxlength: 2000, valor: v('descricao') }, { inteira: true })));

  const form = h('form', {
    onsubmit: aoEnviar(async (dados) => {
      if (editando) {
        await api(`/api/notas-emitidas/${nota.id}`, { metodo: 'PUT', dados });
        dialogo.close();
        avisar('Nota atualizada.');
        rotear();
        return;
      }
      const arquivos = await lerArquivosSelecionados(inputArquivos);
      const r = await api('/api/notas-emitidas', { metodo: 'POST', dados: { ...dados, arquivos } });
      dialogo.close();
      avisar(r.vinculada ? 'Nota registrada e solicitação marcada como emitida.' : `Nota registrada${arquivos.length ? ` com ${arquivos.length} arquivo(s)` : ''}.`);
      rotear();
    }),
  });
  const preencher = (nome, valor) => {
    const el = form.querySelector(`[name=${nome}]`);
    if (valor != null && el) el.value = valor;
  };

  const atualizarVinculo = () => {
    const vinculada = Boolean(selectVinculo.value);
    maisDados.hidden = vinculada;
    for (const el of maisDados.querySelectorAll('input, textarea, select')) el.disabled = vinculada;
  };
  selectVinculo.addEventListener('change', atualizarVinculo);

  // Várias buscas podem estar em andamento (abertura da janela, troca de empresa, leitura
  // do XML); só a mais recente atualiza a lista.
  let ultimaBusca = 0;
  const carregarAbertas = (abertas, sugeridaId) => {
    selectVinculo.replaceChildren(h('option', { value: '' }, 'Nenhuma: registrar como nova nota'),
      ...abertas.map((s) => h('option', { value: s.id, selected: s.id === sugeridaId },
        `#${s.id} · ${s.tomador_nome ?? ''} · ${s.valor_centavos ? moeda(s.valor_centavos) : ''} · ${STATUS[s.status]}`)));
    campoVinculo.hidden = !abertas.length;
    atualizarVinculo();
  };
  const buscarAbertas = async (empresaId) => {
    const busca = ++ultimaBusca;
    const abertas = empresaId ? await api(`/api/empresas/${empresaId}/solicitacoes-abertas`) : [];
    if (busca === ultimaBusca) carregarAbertas(abertas, null);
  };
  if (!empresaFixa && !editando) selectEmpresa.addEventListener('change', () => buscarAbertas(selectEmpresa.value).catch(() => {}));

  inputArquivos.addEventListener('change', async () => {
    caixaLeitura.replaceChildren();
    const xml = [...inputArquivos.files].find(ehXml);
    if (!xml) return;
    const busca = ++ultimaBusca;
    try {
      const r = await api('/api/notas/ler-xml', {
        metodo: 'POST',
        dados: { conteudo_base64: await lerArquivoBase64(xml), empresa_id: selectEmpresa.value || null },
      });
      if (busca !== ultimaBusca) return;
      const d = r.dados;
      if (!empresaFixa && r.empresa_id) selectEmpresa.value = r.empresa_id;
      preencher('numero_nota', d.numero);
      preencher('data_emissao', d.data_emissao);
      preencher('valor', d.valor_centavos == null ? null : reaisCampo(d.valor_centavos));
      preencher('tipo_nota', d.tipo_nota);
      preencher('tomador_documento', documento(d.tomador_documento));
      preencher('tomador_nome', d.tomador_nome?.slice(0, 200));
      preencher('tomador_email', d.tomador_email);
      preencher('descricao', d.descricao?.slice(0, 2000));
      carregarAbertas(r.abertas, r.sugerida_id);
      caixaLeitura.append(h('div', { class: 'alerta sucesso' },
        `XML lido (${d.formato}): nota nº ${d.numero ?? '?'}, ${d.tomador_nome ?? 'tomador não identificado'}, ${d.valor_centavos == null ? 'valor não identificado' : moeda(d.valor_centavos)}.`,
        r.sugerida_id ? h('div', {}, `Vinculada automaticamente à solicitação #${r.sugerida_id} em aberto.`) : null));
      for (const aviso of r.avisos) caixaLeitura.append(h('div', { class: 'alerta erro' }, aviso));
    } catch (err) {
      caixaLeitura.append(h('div', { class: 'alerta info' }, err.message));
    }
  });

  const partes = [
    !editando && h('div', { class: 'grade' },
      h('label', { class: 'inteira' }, 'XML e/ou PDF da nota', inputArquivos),
      empresaFixa ? selectEmpresa : h('label', { class: 'inteira' }, 'Empresa emissora *', selectEmpresa)),
    editando && selectEmpresa,
    !editando && h('p', { class: 'suave peq' }, 'Com o XML, número, data, valor e tomador são preenchidos sozinhos e a empresa é identificada pelo CNPJ do emitente. O anexo é opcional, mas recomendado.'),
    caixaLeitura,
    h('div', { class: 'grade' },
      campo('Número da nota *', { name: 'numero_nota', required: true, maxlength: 50, valor: v('numero_nota') }),
      campo('Data de emissão *', { type: 'date', name: 'data_emissao', required: true, valor: nota?.data_emissao ?? hoje() }),
      campo('Valor (R$)', { name: 'valor', inputmode: 'decimal', placeholder: '0,00', valor: reaisCampo(nota?.valor_centavos) }),
      comOutro(campo('Pedido recebido por', {
        tag: 'select', name: 'canal_pedido', valor: editando ? v('canal_pedido') : 'whatsapp',
        opcoes: [['', '—'], ...Object.entries(opcoes.canais)],
      }), 'canal_outro', { valor: v('canal_outro'), rotulo: 'Qual canal?' }),
      campo('Data do pedido', { type: 'date', name: 'data_pedido', valor: v('data_pedido') }),
      campoVinculo),
    maisDados,
    h('div', { class: 'acoes' },
      h('button', { type: 'submit', class: 'destaque' }, editando ? 'Salvar alterações' : 'Registrar nota'),
      h('button', { type: 'button', class: 'secundario', onclick: () => dialogo.close() }, 'Cancelar')),
  ];
  form.append(...partes.filter(Boolean));

  const titulo = editando ? `Editar nota nº ${nota.numero_nota}` : `Registrar nota emitida${empresaFixa ? ` — ${empresaFixa.razao_social}` : ''}`;
  const dialogo = abrirDialogo(h('h2', {}, titulo), form);
  dialogo.classList.add('largo');
  if (empresaFixa) buscarAbertas(empresaFixa.id).catch(() => {});
}

async function abrirEdicaoNota(id) {
  abrirDialogoNota(null, await api(`/api/solicitacoes/${id}`));
}

async function excluirNota(s) {
  if (!confirm(`Excluir a nota nº ${s.numero_nota ?? s.id} de ${s.empresa_nome}? Os arquivos anexados também serão apagados.`)) return false;
  await api(`/api/solicitacoes/${s.id}`, { metodo: 'DELETE', dados: {} });
  avisar('Nota excluída.');
  return true;
}

function tabelaOcorrencias(lista, op, { mostrarEmpresa = true, aoExcluir }) {
  const excluir = async (o) => {
    if (!confirm(`Excluir ${op.tipos[o.tipo].toLowerCase()} de ${o.empresa_nome} (${data(o.data)})?`)) return;
    try {
      await api(`/api/ocorrencias/${o.id}`, { metodo: 'DELETE', dados: {} });
      avisar('Ocorrência excluída.');
      aoExcluir();
    } catch (err) {
      avisar(err.message, 'erro');
    }
  };
  const cabecalho = ['Data', mostrarEmpresa && 'Empresa', 'Tipo', 'Tributo / comp.', 'Motivo', 'Causa', 'Valor', 'Guia anexada', ''].filter((t) => t !== false);
  return h('div', { class: 'tabela' }, h('table', {},
    h('thead', {}, h('tr', {}, cabecalho.map((t) => h('th', { class: t === 'Valor' ? 'num' : null }, t)))),
    h('tbody', {}, lista.map((o) => h('tr', {},
      h('td', {}, data(o.data)),
      mostrarEmpresa && h('td', {}, h('a', { href: `#/empresa/${o.empresa_id}` }, o.empresa_nome)),
      h('td', {}, h('span', { class: 'etiqueta', style: { '--cor': o.tipo === 'multa' ? 'var(--rejeitada)' : 'var(--pendente)' } }, op.tipos[o.tipo])),
      h('td', {}, o.tributo ? rotuloComOutro(op.tributos, o.tributo, o.tributo_outro) : '—',
        o.competencia ? h('div', { class: 'suave' }, `${o.competencia.slice(5)}/${o.competencia.slice(0, 4)}`) : null),
      h('td', {}, rotuloComOutro(op.motivos[o.tipo], o.motivo, o.motivo_outro), o.descricao ? h('div', { class: 'suave' }, o.descricao) : null),
      h('td', {}, rotuloComOutro(op.causas, o.causa, o.causa_outro)),
      h('td', { class: 'num' }, o.valor_centavos == null ? '—' : moeda(o.valor_centavos)),
      h('td', {}, o.anexos.length
        ? o.anexos.map((a) => h('div', {}, h('a', { href: `/api/ocorrencias/anexos/${a.id}` }, a.nome_arquivo)))
        : h('span', { class: 'suave' }, 'sem anexo')),
      h('td', { class: 'nao-imprimir' }, h('button', { class: 'secundario', onclick: () => excluir(o) }, 'Excluir')))))));
}

async function telaOcorrencias(query) {
  const filtros = new URLSearchParams(query);
  const [opcoes, empresas, lista] = await Promise.all([
    obterOpcoesOcorrencia(),
    api('/api/empresas'),
    api(`/api/ocorrencias?${filtros}`),
  ]);

  const form = h('div', { class: 'cartao' },
    h('h2', {}, 'Registrar ocorrência'),
    h('p', { class: 'suave' }, 'Anexe a guia recalculada ou a guia da multa e informe motivo e causa. Dica: pelo perfil do cliente a empresa já vem preenchida.'),
    formularioOcorrencia({ opcoes, empresas, aoSalvar: rotear }));

  const barraFiltros = h('form', {
    class: 'filtros',
    onsubmit: (ev) => { ev.preventDefault(); filtrosNaUrl('ocorrencias', dadosFormulario(ev.target)); },
  },
  campo('Empresa', { tag: 'select', name: 'empresa_id', valor: filtros.get('empresa_id'), opcoes: [['', 'Todas'], ...empresas.map((e) => [e.id, e.razao_social])] }),
  campo('Tipo', { tag: 'select', name: 'tipo', valor: filtros.get('tipo'), opcoes: [['', 'Todos'], ...Object.entries(opcoes.tipos)] }),
  campo('Causa', { tag: 'select', name: 'causa', valor: filtros.get('causa'), opcoes: [['', 'Todas'], ...Object.entries(opcoes.causas)] }),
  campo('De', { type: 'date', name: 'inicio', valor: filtros.get('inicio') }),
  campo('Até', { type: 'date', name: 'fim', valor: filtros.get('fim') }),
  h('button', { type: 'submit', class: 'secundario' }, 'Filtrar'),
  [...filtros].length ? h('a', { href: '#/ocorrencias', class: 'botao secundario' }, 'Limpar') : null);

  const totalValor = lista.reduce((t, o) => t + (o.valor_centavos ?? 0), 0);
  renderizar(
    h('div', { class: 'cabecalho-pagina' }, h('h1', {}, 'Ocorrências: guias recalculadas e multas')),
    form,
    barraFiltros,
    lista.length
      ? h('div', {},
        h('p', { class: 'suave' }, `${lista.length} ocorrência(s) · total ${moeda(totalValor)}`),
        tabelaOcorrencias(lista, opcoes, { aoExcluir: rotear }))
      : h('div', { class: 'cartao vazio' }, 'Nenhuma ocorrência encontrada.'));
}

async function telaPerfilEmpresa(id, query) {
  const filtros = new URLSearchParams(query);
  const periodo = new URLSearchParams({
    inicio: filtros.get('inicio') || PERIODO_PADRAO.inicio,
    fim: filtros.get('fim') || PERIODO_PADRAO.fim,
  });
  const [empresas, rel, notas, ocorrencias, op] = await Promise.all([
    api('/api/empresas'),
    api(`/api/relatorio?${periodo}&empresa_id=${id}`),
    api(`/api/solicitacoes?${periodo}&empresa_id=${id}`),
    api(`/api/ocorrencias?${periodo}&empresa_id=${id}`),
    obterOpcoesOcorrencia(),
  ]);
  const e = empresas.find((x) => String(x.id) === String(id));
  if (!e) throw new Error('Empresa não encontrada.');
  const r = rel.empresas[0];
  const indicador = (numero, rotulo, cor) => h('div', { class: 'indicador', style: { '--cor': cor, cursor: 'default' } },
    h('div', { class: 'numero' }, numero), h('div', { class: 'rotulo' }, rotulo));
  const textoPeriodo = `${data(periodo.get('inicio'))} a ${data(periodo.get('fim'))}`;

  renderizar(
    // Cabeçalho que só aparece na impressão (ficha do cliente para a reunião de reajuste).
    h('div', { class: 'so-impressao' },
      h('div', { class: 'cabecalho-impressao' },
        h('img', { src: '/marca/logo.webp', alt: 'ContabilizaTech' }),
        h('div', { class: 'suave' }, `Ficha do cliente · ${textoPeriodo} · emitida em ${data(hoje())}`)),
      h('div', { class: 'faixa-marca', style: { marginBottom: '14px' } })),
    h('div', { class: 'cabecalho-pagina' },
      h('div', {},
        h('h1', {}, e.razao_social),
        h('div', { class: 'suave' }, `${e.cnpj.length === 11 ? 'CPF' : 'CNPJ'} ${documento(e.cnpj)} · `,
          rotuloRegime(e) ? `${rotuloRegime(e)} · ` : '', descricaoPlanoTexto(e),
          e.honorario_centavos != null ? ` · honorário ${moeda(e.honorario_centavos)}` : '',
          e.responsavel_nome ? ` · responsável: ${e.responsavel_nome}` : '')),
      h('div', { class: 'acoes', style: { marginTop: 0 } },
        h('button', { class: 'secundario', onclick: () => window.print() }, 'Imprimir ficha / PDF'),
        h('button', { class: 'secundario', onclick: () => abrirFormularioEmpresa(e) }, 'Editar cadastro'),
        h('button', { class: 'secundario', onclick: () => abrirExclusaoEmpresa(e, { aoExcluir: () => { location.hash = '#/empresas'; } }) }, 'Excluir empresa'),
        h('a', { href: '#/empresas' }, '← Clientes'))),
    cartaoCadastro(e),
    h('div', { class: 'acoes-rapidas' },
      h('button', { class: 'acao-rapida destaque', onclick: () => abrirDialogoNota(e) },
        h('strong', {}, 'Registrar nota emitida'), h('span', {}, 'Com XML, os dados são lidos sozinhos')),
      h('button', { class: 'acao-rapida roxo', onclick: () => abrirDialogoOcorrencia('guia_recalculada', e) },
        h('strong', {}, 'Registrar guia recalculada'), h('span', {}, 'Anexe a nova guia e informe o motivo')),
      h('button', { class: 'acao-rapida escuro', onclick: () => abrirDialogoOcorrencia('multa', e) },
        h('strong', {}, 'Registrar multa'), h('span', {}, 'Anexe a guia da multa, motivo e causa'))),
    h('form', {
      class: 'filtros',
      onsubmit: (ev) => { ev.preventDefault(); filtrosNaUrl(`empresa/${id}`, dadosFormulario(ev.target)); },
    },
    campo('De', { type: 'date', name: 'inicio', required: true, valor: periodo.get('inicio') }),
    campo('Até', { type: 'date', name: 'fim', required: true, valor: periodo.get('fim') }),
    h('button', { type: 'submit', class: 'secundario' }, 'Atualizar período')),
    h('div', { class: 'indicadores' },
      indicador(r.notas.total, `Notas no período · média ${String(r.notas.media_mensal).replace('.', ',')}/mês`, 'var(--azul)'),
      e.plano_notas && e.notas_incluidas != null
        ? indicador(r.meses_acima_franquia, `Meses acima da franquia (${e.notas_incluidas}/mês)`, 'var(--rosa)') : null,
      indicador(r.guias.total, `Guias recalculadas · cliente ${r.guias.cliente} · escritório ${r.guias.escritorio}`, 'var(--roxo)'),
      indicador(r.multas.total, `Multas · ${moeda(r.multas.valor_centavos)}`, 'var(--preto)'),
      r.honorario_por_demanda_centavos != null
        ? indicador(moeda(r.honorario_por_demanda_centavos), `Honorário por demanda (${r.demandas} demandas)`, 'var(--azul-claro)') : null),
    h('div', { class: 'cartao' },
      h('h2', {}, 'Notas por mês'),
      h('div', { class: 'meses' }, rel.meses.map((m) => {
        const n = r.notas.por_mes[m];
        const acima = e.plano_notas && e.notas_incluidas != null && n > e.notas_incluidas;
        return h('div', { class: `mes${acima ? ' acima' : ''}` }, h('div', { class: 'suave' }, nomeMes(m)), h('strong', {}, n));
      })),
      r.sinais.length
        ? h('ul', { class: 'sinais', style: { marginTop: '14px' } }, r.sinais.map((s) => h('li', { style: { '--cor': CORES_SINAL[s.tipo] } }, s.texto)))
        : h('p', { class: 'suave', style: { marginTop: '12px' } }, 'Nenhum alerta neste período.')),
    h('h2', {}, 'Notas do período'),
    notas.length
      ? h('div', { class: 'tabela', style: { marginBottom: '20px' } }, h('table', {},
        h('thead', {}, h('tr', {}, ['Nº nota', 'Emissão', 'Tomador', 'Valor', 'Pedido', 'Arquivos'].map((t) => h('th', { class: t === 'Valor' ? 'num' : null }, t)))),
        h('tbody', {}, notas.map((s) => h('tr', { class: 'clicavel', onclick: () => { location.hash = `#/solicitacao/${s.id}`; } },
          h('td', {}, h('strong', {}, s.numero_nota ?? '—'), s.status !== 'emitida' ? h('div', {}, etiqueta(s.status)) : null),
          h('td', {}, data(s.data_nota)),
          h('td', {}, s.tomador_nome ?? '—', s.tomador_documento ? h('div', { class: 'suave' }, documento(s.tomador_documento)) : null),
          h('td', { class: 'num' }, s.valor_centavos ? moeda(s.valor_centavos) : '—'),
          h('td', {}, descricaoPedido(s)),
          h('td', {}, s.anexos ? `${s.anexos} arquivo(s)` : h('span', { class: 'suave' }, 'sem anexo')))))))
      : h('div', { class: 'cartao vazio' }, 'Nenhuma nota neste período.'),
    h('h2', {}, 'Guias recalculadas e multas do período'),
    ocorrencias.length
      ? tabelaOcorrencias(ocorrencias, op, { mostrarEmpresa: false, aoExcluir: rotear })
      : h('div', { class: 'cartao vazio' }, 'Nenhuma ocorrência neste período.'));
}

// Dados cadastrais do cliente no topo do perfil (também saem na ficha impressa).
function cartaoCadastro(e) {
  const local = [e.endereco, [e.cidade, e.uf].filter(Boolean).join('/')].filter(Boolean).join(' · ');
  const itens = [
    ['Nome fantasia', e.nome_fantasia],
    ['Regime tributário', rotuloRegime(e)],
    ['Situação', e.ativo ? 'Ativo' : 'Inativo'],
    ['Início do contrato', e.data_contrato ? data(e.data_contrato) : null],
    ['Contato', [e.email, e.telefone].filter(Boolean).join(' · ')],
    ['Endereço', local],
  ];
  return h('div', { class: 'cartao' },
    h('dl', { class: 'detalhes' },
      itens.map(([rotulo, valor]) => h('div', {}, h('dt', {}, rotulo), h('dd', {}, valor || h('span', { class: 'suave' }, '—')))),
      e.observacoes ? h('div', { class: 'inteira' }, h('dt', {}, 'Observações'), h('dd', {}, e.observacoes)) : null));
}

function descricaoPlanoTexto(e) {
  if (!e.plano_notas) return 'sem plano de notas';
  return `${e.plano_nome || 'com plano'} (${e.notas_incluidas == null ? 'sem limite' : `${e.notas_incluidas} notas/mês`})`;
}

const CORES_SINAL = { upsell: 'var(--em_emissao)', cliente: 'var(--pendente)', qualidade: 'var(--rejeitada)' };
const ROTULOS_SINAL = { upsell: 'Oportunidade de plano', cliente: 'Atenção com o cliente', qualidade: 'Qualidade interna' };

async function telaRelatorio(query) {
  const filtros = new URLSearchParams(query);
  if (!filtros.get('inicio')) filtros.set('inicio', PERIODO_PADRAO.inicio);
  if (!filtros.get('fim')) filtros.set('fim', PERIODO_PADRAO.fim);
  const soAlertas = filtros.get('alertas') === '1';
  const periodo = new URLSearchParams({ inicio: filtros.get('inicio'), fim: filtros.get('fim') });
  if (filtros.get('responsavel_id')) periodo.set('responsavel_id', filtros.get('responsavel_id'));
  const [rel, equipe] = await Promise.all([api(`/api/relatorio?${periodo}`), equipeDoEscritorio()]);
  const empresas = soAlertas ? rel.empresas.filter((e) => e.sinais.length) : rel.empresas;
  const comAlerta = rel.empresas.filter((e) => e.sinais.length).length;
  const oportunidades = rel.empresas.filter((e) => e.sinais.some((s) => s.tipo === 'upsell')).length;

  const indicador = (numero, rotulo, cor) => h('div', { class: 'indicador', style: { '--cor': cor, cursor: 'default' } },
    h('div', { class: 'numero' }, numero), h('div', { class: 'rotulo' }, rotulo));

  const contagemCausa = (c) => `cliente ${c.cliente} · escritório ${c.escritorio} · outro ${c.outro}`;

  renderizar(
    h('div', { class: 'cabecalho-pagina' },
      h('h1', {}, 'Relatório operacional por cliente'),
      h('a', { class: 'botao secundario', href: `/api/relatorio.csv?${periodo}` }, 'Exportar CSV (Excel)')),
    h('form', {
      class: 'filtros',
      onsubmit: (ev) => {
        ev.preventDefault();
        const d = dadosFormulario(ev.target);
        filtrosNaUrl('relatorio', { inicio: d.inicio, fim: d.fim, responsavel_id: d.responsavel_id, alertas: ev.target.alertas.checked ? '1' : '' });
      },
    },
    campo('De', { type: 'date', name: 'inicio', required: true, valor: filtros.get('inicio') }),
    campo('Até', { type: 'date', name: 'fim', required: true, valor: filtros.get('fim') }),
    campo('Responsável', { tag: 'select', name: 'responsavel_id', valor: filtros.get('responsavel_id'), opcoes: [['', 'Toda a equipe'], ...equipe.map((u) => [u.id, u.nome])] }),
    h('label', { class: 'checkbox' }, h('input', { type: 'checkbox', name: 'alertas', checked: soAlertas }), 'Só clientes com alerta'),
    h('button', { type: 'submit', class: 'secundario' }, 'Atualizar')),
    h('div', { class: 'indicadores' },
      indicador(rel.totais.notas, 'Notas emitidas', 'var(--azul)'),
      indicador(rel.totais.guias, `Guias recalculadas · ${contagemCausa(rel.totais.por_causa.guia_recalculada)}`, 'var(--pendente)'),
      indicador(rel.totais.multas, `Multas · ${moeda(rel.totais.multas_valor_centavos)} · ${contagemCausa(rel.totais.por_causa.multa)}`, 'var(--rejeitada)'),
      indicador(oportunidades, 'Clientes com oportunidade de plano', 'var(--emitida)'),
      indicador(comAlerta, 'Clientes com algum alerta', 'var(--cancelada)')),
    rel.totais.por_motivo.length ? h('div', { class: 'cartao' },
      h('h2', {}, 'Motivos mais frequentes'),
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Tipo'), h('th', {}, 'Motivo'), h('th', { class: 'num' }, 'Quantidade'), h('th', { class: 'num' }, 'Valor'))),
        h('tbody', {}, rel.totais.por_motivo.map((m) => h('tr', {},
          h('td', {}, m.tipo === 'multa' ? 'Multa' : 'Guia recalculada'),
          h('td', {}, m.rotulo),
          h('td', { class: 'num' }, m.quantidade),
          h('td', { class: 'num' }, m.valor_centavos ? moeda(m.valor_centavos) : '—')))))) : null,
    h('div', { class: 'legenda' }, Object.entries(ROTULOS_SINAL).map(([tipo, rotulo]) =>
      h('span', { class: 'etiqueta', style: { '--cor': CORES_SINAL[tipo] } }, rotulo))),
    empresas.length
      ? h('div', { class: 'tabela' }, h('table', { class: 'relatorio' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'Cliente / plano'),
          rel.meses.map((m) => h('th', { class: 'num' }, nomeMes(m))),
          h('th', { class: 'num' }, 'Total'), h('th', { class: 'num' }, 'Média/mês'),
          h('th', { class: 'num' }, 'Guias'), h('th', { class: 'num' }, 'Multas'),
          h('th', { class: 'num', title: 'Honorário do período dividido por notas + guias + multas' }, 'Honorário / demanda'),
          h('th', {}, 'Alertas'))),
        h('tbody', {}, empresas.map((e) => h('tr', {},
          h('td', {}, h('a', { href: `#/empresa/${e.id}` }, h('strong', {}, e.razao_social)), h('div', { class: 'suave' },
            e.plano_notas ? `${e.plano_nome || 'Com plano'} · ${e.notas_incluidas == null ? 'sem limite' : `${e.notas_incluidas}/mês`}` : 'Sem plano de notas',
            e.honorario_centavos != null ? ` · ${moeda(e.honorario_centavos)}` : '',
            e.responsavel_nome ? ` · ${e.responsavel_nome}` : '')),
          rel.meses.map((m) => {
            const n = e.notas.por_mes[m];
            const acima = e.plano_notas && e.notas_incluidas != null && n > e.notas_incluidas;
            return h('td', { class: `num${acima ? ' acima' : ''}`, title: acima ? 'Acima da franquia' : null }, n);
          }),
          h('td', { class: 'num' }, h('strong', {}, e.notas.total)),
          h('td', { class: 'num' }, String(e.notas.media_mensal).replace('.', ',')),
          h('td', { class: 'num' }, e.guias.total, e.guias.total ? h('div', { class: 'suave' }, `cli ${e.guias.cliente} · esc ${e.guias.escritorio}`) : null),
          h('td', { class: 'num' }, e.multas.total, e.multas.total ? h('div', { class: 'suave' }, moeda(e.multas.valor_centavos)) : null),
          h('td', { class: 'num' }, e.honorario_por_demanda_centavos == null ? '—' : moeda(e.honorario_por_demanda_centavos),
            e.demandas ? h('div', { class: 'suave' }, `${e.demandas} demanda(s)`) : null),
          h('td', {}, e.sinais.length
            ? h('ul', { class: 'sinais' }, e.sinais.map((s) => h('li', { style: { '--cor': CORES_SINAL[s.tipo] } }, s.texto)))
            : h('span', { class: 'suave' }, '—')))))))
      : h('div', { class: 'cartao vazio' }, 'Nenhum cliente para mostrar neste período.'),
    h('p', { class: 'suave peq' },
      `Notas contam pela data de emissão. Honorário por demanda = honorário do período ÷ (notas + guias + multas): quanto menor, mais trabalho o cliente dá pelo que paga. Alerta de plano: cliente sem plano com média de ${String(rel.limites.mediaNotasSemPlano).replace('.', ',')} ou mais notas/mês, ou com plano que passou da franquia em algum mês.`));
}

async function telaUsuarios() {
  const [usuarios, empresas] = await Promise.all([api('/api/usuarios'), api('/api/empresas')]);

  const formNovo = h('form', {
    class: 'cartao',
    onsubmit: aoEnviar(async (dados, form) => {
      await api('/api/usuarios', { metodo: 'POST', dados });
      form.reset();
      avisar('Usuário criado. Envie o e-mail e a senha para a pessoa.');
      rotear();
    }),
  },
  h('h2', {}, 'Novo usuário da equipe'),
  h('div', { class: 'grade' },
    campo('Nome *', { name: 'nome', required: true }),
    campo('E-mail *', { type: 'email', name: 'email', required: true }),
    campo('Senha inicial *', { type: 'text', name: 'senha', required: true, minlength: 8, autocomplete: 'new-password' }),
    opcoes.clientes_entram
      ? [campo('Perfil', { tag: 'select', name: 'papel', opcoes: [['escritorio', 'Equipe do escritório'], ['cliente', 'Cliente (empresa)']] }),
        campo('Empresa (para clientes)', { tag: 'select', name: 'empresa_id', opcoes: [['', '—'], ...empresas.map((e) => [e.id, e.razao_social])] })]
      : h('input', { type: 'hidden', name: 'papel', value: 'escritorio' }),
    usuario.admin ? h('label', { class: 'checkbox' }, h('input', { type: 'checkbox', name: 'admin', value: '1' }), 'Administrador (pode excluir em lote e gerenciar administradores)') : null),
  h('div', { class: 'acoes' }, h('button', { type: 'submit' }, 'Criar usuário')));

  const alternarAtivo = async (u) => {
    try {
      await api(`/api/usuarios/${u.id}`, { metodo: 'PUT', dados: { nome: u.nome, ativo: !u.ativo } });
      rotear();
    } catch (err) {
      avisar(err.message, 'erro');
    }
  };
  const alternarAdmin = async (u) => {
    const acao = u.admin ? 'remover o perfil de administrador de' : 'tornar administrador(a)';
    if (!confirm(`Deseja ${acao} ${u.nome}?`)) return;
    try {
      await api(`/api/usuarios/${u.id}`, { metodo: 'PUT', dados: { nome: u.nome, ativo: Boolean(u.ativo), admin: !u.admin } });
      rotear();
    } catch (err) {
      avisar(err.message, 'erro');
    }
  };
  const redefinirSenha = async (u) => {
    const senha = prompt(`Nova senha para ${u.nome} (mínimo 8 caracteres):`);
    if (!senha) return;
    try {
      await api(`/api/usuarios/${u.id}`, { metodo: 'PUT', dados: { nome: u.nome, ativo: Boolean(u.ativo), senha } });
      avisar('Senha redefinida.');
    } catch (err) {
      avisar(err.message, 'erro');
    }
  };

  renderizar(
    h('div', { class: 'cabecalho-pagina' }, h('h1', {}, 'Usuários')),
    formNovo,
    h('div', { class: 'tabela' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Nome', 'E-mail', 'Perfil', 'Empresa', 'Situação', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, usuarios.map((u) => h('tr', {},
        h('td', {}, u.nome),
        h('td', {}, u.email),
        h('td', {}, u.papel === 'escritorio' ? 'Escritório' : 'Cliente',
          u.admin ? h('div', {}, h('span', { class: 'etiqueta', style: { '--cor': 'var(--rosa)' } }, 'Administrador')) : null),
        h('td', {}, u.empresa_nome ?? '—'),
        h('td', {}, u.ativo ? 'Ativo' : 'Inativo'),
        h('td', {}, h('div', { class: 'acoes', style: { marginTop: 0 } },
          h('button', { class: 'secundario', onclick: () => redefinirSenha(u) }, 'Redefinir senha'),
          usuario.admin && u.papel === 'escritorio' && u.id !== usuario.id
            && h('button', { class: 'secundario', onclick: () => alternarAdmin(u) }, u.admin ? 'Remover admin' : 'Tornar admin'),
          u.id !== usuario.id && h('button', { class: 'secundario', onclick: () => alternarAtivo(u) }, u.ativo ? 'Desativar' : 'Reativar')))))))));
}

// ---------------------------------------------------------------------------
// Questor Zen (documentos recebidos pelo webhook) e portal do cliente
// ---------------------------------------------------------------------------

const ROTULOS_ASSOCIACAO = {
  email: 'pelo e-mail do usuário',
  cnpj: 'pelo CNPJ',
  nome: 'pelo nome',
  anterior: 'como no documento anterior',
  manual: 'pela equipe',
};

const competenciaTexto = (c) => (c ? `${c.slice(5, 7)}/${c.slice(0, 4)}` : '');

function linkArquivoZen(d) {
  if (d.tem_arquivo) return h('a', { href: `/api/zen/documentos/${d.id}/arquivo` }, d.nome_arquivo ?? 'Baixar');
  return null;
}

async function abrirDocumentoZen(id, empresas) {
  const d = await api(`/api/zen/documentos/${id}`);
  const link = /^Link recebido: (https:\/\/\S+)$/.exec(d.arquivo_info ?? '');
  const linha = (rotulo, valor) => (valor ? h('div', {}, h('span', { class: 'suave' }, `${rotulo}: `), valor) : null);
  const dialogo = abrirDialogo(h('form', {
    onsubmit: aoEnviar(async (dados) => {
      await api(`/api/zen/documentos/${id}/empresa`, { metodo: 'PUT', dados: { empresa_id: dados.empresa_id || null } });
      dialogo.close();
      avisar('Empresa do documento atualizada.');
      rotear();
    }),
  },
  h('h2', {}, d.titulo ?? 'Documento do Zen'),
  h('div', { class: 'peq', style: { display: 'grid', gap: '4px', marginBottom: '12px' } },
    linha('Categoria', d.categoria),
    linha('Cliente no Zen', d.cliente_nome),
    linha('E-mails de destino', d.destinatarios_emails),
    linha('Vencimento', data(d.vencimento)),
    linha('Competência', competenciaTexto(d.competencia)),
    linha('Valor', d.valor_centavos != null ? moeda(d.valor_centavos) : null),
    linha('Observação', d.observacao),
    linha('Situação no Zen', d.status),
    linha('ID no Zen', d.zen_id),
    linha('Recebido em', dataHora(d.recebido_em)),
    linha('Formato recebido', d.tipo_conteudo),
    linha('Arquivo', d.tem_arquivo ? linkArquivoZen(d) : null)),
  d.arquivo_info ? h('div', { class: 'alerta info' }, link ? ['Link recebido: ', h('a', { href: link[1], target: '_blank', rel: 'noopener' }, link[1])] : d.arquivo_info) : null,
  campo('Empresa (quem vê no portal)', {
    tag: 'select', name: 'empresa_id', valor: d.empresa_id ?? '',
    opcoes: [['', '— sem empresa —'], ...empresas.map((e) => [e.id, e.razao_social])],
  }),
  h('p', { class: 'suave peq' }, d.empresa_id && d.associacao ? `Associada ${ROTULOS_ASSOCIACAO[d.associacao] ?? ''}. ` : '',
    'Ao associar manualmente, os próximos documentos do mesmo cliente do Zen vão para a mesma empresa.'),
  h('details', {}, h('summary', {}, 'Dados recebidos do Zen'),
    h('pre', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '300px', overflow: 'auto', fontSize: '12px' } }, d.payload)),
  h('div', { class: 'acoes' },
    h('button', { type: 'submit' }, 'Salvar empresa'),
    usuario.admin && h('button', {
      type: 'button', class: 'perigo',
      onclick: async () => {
        if (!confirm('Apagar este documento recebido do sistema? (No Zen ele continua.)')) return;
        await api(`/api/zen/documentos/${id}`, { metodo: 'DELETE', dados: {} });
        dialogo.close();
        avisar('Documento apagado.');
        rotear();
      },
    }, 'Apagar'),
    h('button', { type: 'button', class: 'secundario', onclick: () => dialogo.close() }, 'Fechar'))));
}

async function telaZen() {
  const [status, docs, empresas] = await Promise.all([api('/api/zen/status'), api('/api/zen/documentos'), api('/api/empresas')]);
  const urlWebhook = `${location.origin}/api/zen/webhook`;

  const configuracao = h('div', { class: 'cartao' },
    h('h2', {}, 'Webhook do Questor Zen'),
    status.webhook_configurado
      ? h('div', { class: 'alerta sucesso' }, 'Recebimento ligado. ',
        status.ultimo_recebimento ? `Último documento recebido em ${dataHora(status.ultimo_recebimento)}.` : 'Nenhum documento recebido ainda.')
      : h('div', { class: 'alerta erro' }, 'Recebimento desligado: falta a variável ZEN_WEBHOOK_TOKEN no servidor (veja docs/IMPLANTACAO.md).'),
    h('p', {}, 'No Questor Zen, em ', h('strong', {}, 'Configurações Gerais'), ', informe:'),
    h('ul', {},
      h('li', {}, 'URL de retorno: ', h('code', {}, urlWebhook)),
      h('li', {}, 'Autenticação: ', h('strong', {}, 'Bearer Token'), ' com o valor de ZEN_WEBHOOK_TOKEN.')),
    h('p', { class: 'suave peq' },
      'Cada documento postado no Zen chega aqui e é ligado à empresa pelo e-mail do usuário cliente, pelo CNPJ ou pelo nome. ',
      'Os que ficarem sem empresa aparecem destacados: abra e escolha a empresa.'),
    !opcoes.clientes_entram ? h('p', { class: 'suave peq' },
      'O portal do cliente está desligado; ligue com PORTAL_CLIENTES=1 para os clientes verem os documentos.') : null,
    usuario.admin && status.webhook_configurado ? h('form', {
      class: 'filtros', style: { marginTop: '12px' },
      onsubmit: aoEnviar(async (dados) => {
        const r = await api('/api/zen/teste', { metodo: 'POST', dados });
        avisar(r.empresa_id ? 'Documento de teste recebido e associado.' : 'Documento de teste recebido.');
        rotear();
      }),
    },
    campo('Simular um envio do Zen para', { tag: 'select', name: 'empresa_id', required: true, opcoes: [['', 'Escolha a empresa…'], ...empresas.map((e) => [e.id, e.razao_social])] }),
    h('button', { type: 'submit', class: 'secundario' }, 'Simular recebimento')) : null);

  const tabela = docs.length
    ? h('div', { class: 'tabela' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Recebido em', 'Documento', 'Cliente no Zen', 'Empresa', 'Vencimento', 'Valor', 'Arquivo'].map((t) => h('th', {}, t)))),
      h('tbody', {}, docs.map((d) => h('tr', { class: 'clicavel', onclick: (ev) => { if (ev.target.tagName !== 'A') abrirDocumentoZen(d.id, empresas); } },
        h('td', {}, dataHora(d.recebido_em)),
        h('td', {}, d.titulo ?? '—', h('div', { class: 'suave' }, d.categoria ?? '')),
        h('td', {}, d.cliente_nome ?? '—', d.destinatarios_emails ? h('div', { class: 'suave' }, d.destinatarios_emails) : null),
        h('td', {}, d.empresa_id
          ? d.empresa_nome
          : h('span', { class: 'etiqueta', style: { '--cor': 'var(--rejeitada)' } }, 'Sem empresa')),
        h('td', {}, data(d.vencimento)),
        h('td', { class: 'num' }, d.valor_centavos != null ? moeda(d.valor_centavos) : ''),
        h('td', {}, linkArquivoZen(d) ?? h('span', { class: 'suave', title: d.arquivo_info ?? '' }, 'sem arquivo')))))))
    : h('div', { class: 'cartao vazio' }, 'Nenhum documento recebido do Zen ainda.');

  renderizar(
    h('div', { class: 'cabecalho-pagina' }, h('h1', {}, 'Questor Zen'),
      status.sem_empresa ? h('span', { class: 'etiqueta', style: { '--cor': 'var(--rejeitada)' } }, `${status.sem_empresa} sem empresa`) : null),
    configuracao,
    h('h2', {}, `Documentos recebidos (${docs.length})`),
    tabela);
}

async function telaPortalDocumentos() {
  const docs = await api('/api/portal/documentos');
  const detalhe = (rotulo, valor) => (valor ? h('span', {}, h('span', { class: 'suave' }, `${rotulo} `), valor) : null);
  renderizar(
    h('div', { class: 'cabecalho-pagina' }, h('h1', {}, 'Meus documentos'),
      h('span', { class: 'suave' }, usuario.empresa?.razao_social ?? '')),
    docs.length
      ? h('div', { class: 'docs-portal' }, docs.map((d) => h('div', { class: 'cartao doc-portal' },
        h('div', { class: 'doc-portal-texto' },
          h('strong', {}, d.titulo ?? 'Documento'),
          d.categoria ? h('div', { class: 'suave peq' }, d.categoria) : null,
          h('div', { class: 'doc-portal-dados peq' },
            detalhe('Competência', competenciaTexto(d.competencia)),
            detalhe('Vencimento', data(d.vencimento)),
            detalhe('Valor', d.valor_centavos != null ? moeda(d.valor_centavos) : null),
            detalhe('Recebido em', data(d.recebido_em))),
          d.observacao ? h('div', { class: 'suave peq' }, d.observacao) : null),
        d.tem_arquivo
          ? h('a', { class: 'botao', href: `/api/zen/documentos/${d.id}/arquivo` }, 'Baixar')
          : h('span', { class: 'suave peq' }, 'sem arquivo'))))
      : h('div', { class: 'cartao vazio' }, 'Nenhum documento disponível ainda. Os documentos enviados pelo escritório aparecem aqui.'));
}

function telaSenha() {
  renderizar(
    h('h1', {}, 'Trocar senha'),
    h('form', {
      class: 'cartao', style: { maxWidth: '460px' },
      onsubmit: aoEnviar(async (dados, form) => {
        if (dados.nova_senha !== dados.confirmacao) throw new Error('A confirmação não confere com a nova senha.');
        await api('/api/me/senha', { metodo: 'POST', dados });
        form.reset();
        avisar('Senha alterada com sucesso.');
      }),
    },
    h('div', { class: 'grade' },
      campo('Senha atual', { type: 'password', name: 'senha_atual', required: true, autocomplete: 'current-password' }, { inteira: true }),
      campo('Nova senha (mín. 8 caracteres)', { type: 'password', name: 'nova_senha', required: true, minlength: 8, autocomplete: 'new-password' }, { inteira: true }),
      campo('Confirme a nova senha', { type: 'password', name: 'confirmacao', required: true, minlength: 8, autocomplete: 'new-password' }, { inteira: true })),
    h('div', { class: 'acoes' }, h('button', { type: 'submit' }, 'Salvar'))));
}

// ---------------------------------------------------------------------------
// Navegação
// ---------------------------------------------------------------------------

// Quando a opção "Outro" é escolhida num select, mostra um campo obrigatório para descrevê-la.
function comOutro(rotuloSelect, nomeOutro, { valor = '', rotulo = 'Descreva' } = {}) {
  const select = rotuloSelect.querySelector('select');
  const campoOutro = campo(`${rotulo} *`, { name: nomeOutro, maxlength: 200, valor });
  campoOutro.classList.add('campo-outro');
  const input = campoOutro.querySelector('input');
  const atualizar = () => {
    const outro = select.value === 'outro';
    campoOutro.hidden = !outro;
    input.required = outro;
    input.disabled = !outro;
  };
  select.addEventListener('change', atualizar);
  atualizar();
  return [rotuloSelect, campoOutro];
}

const rotuloComOutro = (mapa, valor, outro) => (valor === 'outro' && outro ? `Outro: ${outro}` : mapa[valor] ?? valor ?? '—');
const reaisCampo = (centavos) => (centavos == null ? '' : (centavos / 100).toFixed(2).replace('.', ','));
const nomeDoMes = (mes) => new Date(`${mes}-15T12:00:00`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
const diasEntre = (de, ate) => Math.round((Date.parse(ate) - Date.parse(de)) / 86400000);

function descricaoPedido(s) {
  if (!s.canal_pedido && !s.data_pedido) return h('span', { class: 'suave' }, '—');
  const canal = s.canal_pedido ? rotuloComOutro(opcoes.canais, s.canal_pedido, s.canal_outro) : 'Pedido';
  if (!s.data_pedido || !s.data_emissao) return canal;
  const dias = diasEntre(s.data_pedido, s.data_emissao);
  return [canal, h('div', { class: 'suave' }, dias === 0 ? 'emitida no mesmo dia' : `emitida em ${dias} dia(s)`)];
}

async function equipeDoEscritorio() {
  return (await api('/api/usuarios')).filter((u) => u.papel === 'escritorio' && u.ativo);
}

// Lançamento em lote: vários XMLs de uma vez; cada um é lido e associado à empresa pelo CNPJ do emitente.
async function abrirLoteXml() {
  const empresas = (await api('/api/empresas')).filter((e) => e.ativo);
  const inputArquivos = h('input', { type: 'file', multiple: true, accept: '.xml,.pdf' });
  const resultado = h('div', {});
  const dialogo = abrirDialogo(
    h('h2', {}, 'Lançar notas em lote'),
    h('p', { class: 'suave' },
      'Selecione os XMLs das notas emitidas (por exemplo, todas as do dia). Cada XML é lido, a empresa é identificada pelo CNPJ ',
      'do emitente e você confere antes de gravar. Se tiver os PDFs, selecione junto: cada PDF é anexado à nota de mesmo nome ou número.'),
    h('label', {}, 'Arquivos', inputArquivos),
    resultado,
    h('div', { class: 'acoes' }, h('button', { type: 'button', class: 'secundario', onclick: () => dialogo.close() }, 'Fechar')));
  dialogo.classList.add('extra-largo');

  inputArquivos.addEventListener('change', async () => {
    const arquivos = [...inputArquivos.files];
    const xmls = arquivos.filter(ehXml);
    const pdfs = arquivos.filter((a) => !ehXml(a));
    if (!xmls.length) {
      resultado.replaceChildren(h('div', { class: 'alerta erro' }, 'Selecione ao menos um XML.'));
      return;
    }
    resultado.replaceChildren(h('p', { class: 'suave' }, `Lendo ${xmls.length} XML(s)…`));
    const itens = [];
    for (const xml of xmls) {
      const item = { xml, pdf: null, dados: null, empresa_id: '', avisos: [], erro: null };
      try {
        if (xml.size > 10 * 1024 * 1024) throw new Error('Arquivo maior que 10 MB.');
        const r = await api('/api/notas/ler-xml', { metodo: 'POST', dados: { conteudo_base64: await lerArquivoBase64(xml) } });
        item.dados = r.dados;
        item.empresa_id = r.empresa_id ?? '';
        item.avisos = r.avisos;
        const base = xml.name.replace(/\.xml$/i, '').toLowerCase();
        item.pdf = pdfs.find((p) => p.name.replace(/\.pdf$/i, '').toLowerCase() === base)
          ?? pdfs.find((p) => r.dados.numero && p.name.includes(r.dados.numero)) ?? null;
      } catch (err) {
        item.erro = err.message;
      }
      itens.push(item);
    }
    mostrar(itens);
  });

  function mostrar(itens) {
    const situacao = (item) => {
      if (item.erro) return { rotulo: 'Não lido', cor: 'var(--rejeitada)', msg: item.erro };
      if (item.avisos.some((a) => /já está registrada/.test(a))) return { rotulo: 'Já registrada', cor: 'var(--cancelada)', msg: item.avisos.join(' ') };
      if (item.avisos.length) return { rotulo: 'Conferir', cor: 'var(--pendente)', msg: item.avisos.join(' ') };
      return { rotulo: 'Pronta', cor: 'var(--emitida)', msg: null };
    };
    const botao = h('button', { type: 'button', class: 'destaque' });
    const contar = () => {
      const n = itens.filter((i) => i.marcar?.checked).length;
      botao.textContent = `Registrar ${n} nota(s)`;
      botao.disabled = n === 0;
    };
    const canal = comOutro(campo('Pedido recebido por (vale para todas)', {
      tag: 'select', name: 'canal_pedido', valor: 'whatsapp', opcoes: [['', '—'], ...Object.entries(opcoes.canais)],
    }), 'canal_outro', { rotulo: 'Qual canal?' });

    const linhas = itens.map((item) => {
      const sit = situacao(item);
      item.marcar = item.erro ? null : h('input', { type: 'checkbox', checked: sit.rotulo !== 'Já registrada', onchange: contar });
      item.selectEmpresa = h('select', {}, h('option', { value: '' }, 'Selecione…'),
        empresas.map((e) => h('option', { value: e.id, selected: String(e.id) === String(item.empresa_id) }, e.razao_social)));
      item.celulaSituacao = h('td', {}, h('span', { class: 'etiqueta', style: { '--cor': sit.cor } }, sit.rotulo),
        sit.msg ? h('div', { class: 'suave' }, sit.msg) : null);
      const d = item.dados ?? {};
      return h('tr', {},
        h('td', {}, item.marcar),
        h('td', {}, item.xml.name, item.pdf ? h('div', { class: 'suave' }, `+ ${item.pdf.name}`) : null),
        h('td', {}, item.erro ? '—' : item.selectEmpresa),
        h('td', {}, d.numero ?? '—'),
        h('td', {}, data(d.data_emissao) || '—'),
        h('td', {}, d.tomador_nome ?? '—'),
        h('td', { class: 'num' }, d.valor_centavos ? moeda(d.valor_centavos) : '—'),
        item.celulaSituacao);
    });

    botao.addEventListener('click', async () => {
      const escolhidos = itens.filter((i) => i.marcar?.checked);
      const canalPedido = canal[0].querySelector('select').value;
      const canalOutro = canal[1].querySelector('input').value;
      if (canalPedido === 'outro' && !canalOutro.trim()) { avisar('Descreva o canal do pedido.', 'erro'); return; }
      botao.disabled = true;
      let ok = 0;
      for (const item of escolhidos) {
        const d = item.dados;
        try {
          if (!item.selectEmpresa.value) throw new Error('Selecione a empresa.');
          const arquivos = [{ nome_arquivo: item.xml.name, tipo_mime: 'application/xml', conteudo_base64: await lerArquivoBase64(item.xml) }];
          if (item.pdf) arquivos.push({ nome_arquivo: item.pdf.name, tipo_mime: 'application/pdf', conteudo_base64: await lerArquivoBase64(item.pdf) });
          await api('/api/notas-emitidas', {
            metodo: 'POST',
            dados: {
              empresa_id: item.selectEmpresa.value,
              numero_nota: d.numero,
              data_emissao: d.data_emissao,
              valor: d.valor_centavos ? (d.valor_centavos / 100).toFixed(2) : '',
              tipo_nota: d.tipo_nota,
              tomador_documento: d.tomador_documento,
              tomador_nome: d.tomador_nome?.slice(0, 200),
              tomador_email: d.tomador_email,
              descricao: d.descricao?.slice(0, 2000),
              canal_pedido: canalPedido,
              canal_outro: canalOutro,
              arquivos,
            },
          });
          ok++;
          item.marcar.checked = false;
          item.marcar.disabled = true;
          item.celulaSituacao.replaceChildren(h('span', { class: 'etiqueta', style: { '--cor': 'var(--emitida)' } }, 'Registrada'));
        } catch (err) {
          item.celulaSituacao.replaceChildren(h('span', { class: 'etiqueta', style: { '--cor': 'var(--rejeitada)' } }, 'Erro'),
            h('div', { class: 'suave' }, err.message));
        }
      }
      const falhas = escolhidos.length - ok;
      avisar(`${ok} nota(s) registrada(s)${falhas ? `, ${falhas} com erro (veja a lista)` : ''}.`, falhas ? 'erro' : 'sucesso');
      contar();
      if (!falhas) {
        dialogo.close();
        rotear();
      }
    });

    const conta = (r) => itens.filter((i) => situacao(i).rotulo === r).length;
    resultado.replaceChildren(
      h('div', { class: 'alerta info' }, `${itens.length} XML(s): ${conta('Pronta')} pronta(s), ${conta('Conferir')} para conferir, `,
        `${conta('Já registrada')} já registrada(s), ${conta('Não lido')} não lido(s).`),
      h('div', { class: 'grade' }, canal),
      h('div', { class: 'tabela tabela-rolagem' }, h('table', {},
        h('thead', {}, h('tr', {}, ['', 'Arquivo', 'Empresa', 'Nº', 'Emissão', 'Tomador', 'Valor', 'Situação'].map((t) => h('th', { class: t === 'Valor' ? 'num' : null }, t)))),
        h('tbody', {}, linhas))),
      h('div', { class: 'acoes' }, botao));
    contar();
  }
}

// Painel inicial do escritório: números do mês, franquia de cada cliente e atalhos de lançamento.
async function telaPainelMes(query) {
  const filtros = new URLSearchParams(query);
  const mes = filtros.get('mes') || hoje().slice(0, 7);
  const [ano, numMes] = mes.split('-').map(Number);
  const ultimoDia = String(new Date(ano, numMes, 0).getDate()).padStart(2, '0');
  const periodo = new URLSearchParams({ inicio: `${mes}-01`, fim: `${mes}-${ultimoDia}` });
  if (filtros.get('responsavel_id')) periodo.set('responsavel_id', filtros.get('responsavel_id'));
  const [rel, equipe] = await Promise.all([api(`/api/relatorio?${periodo}`), equipeDoEscritorio()]);

  const comFranquia = rel.empresas
    .filter((e) => e.plano_notas && e.notas_incluidas)
    .map((e) => ({ ...e, uso: e.notas.total / e.notas_incluidas }))
    .sort((a, b) => b.uso - a.uso);
  const perto = comFranquia.filter((e) => e.uso >= 0.8).length;
  const maisNotas = rel.empresas.filter((e) => e.notas.total > 0).sort((a, b) => b.notas.total - a.notas.total).slice(0, 8);

  const indicador = (numero, rotulo, cor, href) => h('div', {
    class: 'indicador', style: { '--cor': cor }, onclick: href ? () => { location.hash = href; } : null,
  }, h('div', { class: 'numero' }, numero), h('div', { class: 'rotulo' }, rotulo));

  renderizar(
    h('div', { class: 'cabecalho-pagina' },
      h('h1', {}, `Painel de notas · ${nomeDoMes(mes)}`),
      h('form', {
        class: 'filtros', style: { marginBottom: 0 },
        onsubmit: (ev) => { ev.preventDefault(); filtrosNaUrl('painel-notas', dadosFormulario(ev.target)); },
        onchange: (ev) => ev.currentTarget.requestSubmit(),
      },
      campo('Mês', { type: 'month', name: 'mes', valor: mes }),
      campo('Responsável', { tag: 'select', name: 'responsavel_id', valor: filtros.get('responsavel_id'), opcoes: [['', 'Toda a equipe'], ...equipe.map((u) => [u.id, u.nome])] }))),
    h('div', { class: 'acoes-rapidas' },
      h('button', { class: 'acao-rapida destaque', onclick: () => abrirDialogoNota() },
        h('strong', {}, 'Registrar nota'), h('span', {}, 'Pedido do WhatsApp emitido? Lance aqui')),
      h('button', { class: 'acao-rapida', onclick: abrirLoteXml },
        h('strong', {}, 'Lançar XMLs em lote'), h('span', {}, 'Várias notas de uma vez')),
      h('button', { class: 'acao-rapida roxo', onclick: () => abrirDialogoOcorrencia('guia_recalculada') },
        h('strong', {}, 'Guia recalculada'), h('span', {}, 'Com a guia anexada')),
      h('button', { class: 'acao-rapida escuro', onclick: () => abrirDialogoOcorrencia('multa') },
        h('strong', {}, 'Multa'), h('span', {}, 'Com a guia e o motivo'))),
    h('div', { class: 'indicadores' },
      indicador(rel.totais.notas, 'Notas emitidas no mês', 'var(--azul)', `#/notas?mes=${mes}`),
      indicador(rel.totais.guias, 'Guias recalculadas', 'var(--roxo)', `#/ocorrencias?tipo=guia_recalculada&inicio=${periodo.get('inicio')}&fim=${periodo.get('fim')}`),
      indicador(rel.totais.multas, `Multas · ${moeda(rel.totais.multas_valor_centavos)}`, 'var(--preto)', `#/ocorrencias?tipo=multa&inicio=${periodo.get('inicio')}&fim=${periodo.get('fim')}`),
      indicador(perto, 'Clientes com 80% ou mais da franquia', 'var(--rosa)', null)),
    h('div', { class: 'colunas' },
      h('div', { class: 'cartao' },
        h('h2', {}, 'Franquia de notas no mês'),
        comFranquia.length
          ? h('table', { class: 'manter' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Cliente'), h('th', { class: 'num' }, 'Usadas'), h('th', {}, 'Uso'))),
            h('tbody', {}, comFranquia.map((e) => {
              const pct = Math.round(e.uso * 100);
              const classe = e.uso > 1 ? 'estourou' : e.uso >= 0.8 ? 'alerta-80' : '';
              return h('tr', {},
                h('td', {}, h('a', { href: `#/empresa/${e.id}` }, e.razao_social), h('div', { class: 'suave' }, e.plano_nome ?? '')),
                h('td', { class: 'num' }, `${e.notas.total} de ${e.notas_incluidas}`),
                h('td', {}, h('div', { class: 'suave' }, `${pct}%${e.uso > 1 ? ' · acima da franquia' : ''}`),
                  h('div', { class: `barra ${classe}` }, h('span', { style: { width: `${Math.min(100, pct)}%` } }))));
            })))
          : h('p', { class: 'suave' }, 'Nenhum cliente com franquia de notas cadastrada. Informe o plano em Empresas → Editar.')),
      h('div', { class: 'cartao' },
        h('h2', {}, 'Quem mais pediu notas'),
        maisNotas.length
          ? h('table', { class: 'manter' }, h('tbody', {}, maisNotas.map((e) => h('tr', {},
            h('td', {}, h('a', { href: `#/empresa/${e.id}` }, e.razao_social),
              h('div', { class: 'suave' }, e.plano_notas ? (e.plano_nome || 'Com plano') : 'Sem plano de notas')),
            h('td', { class: 'num' }, h('strong', {}, e.notas.total))))))
          : h('p', { class: 'suave' }, 'Nenhuma nota registrada neste mês ainda.'))));
}

async function telaNotas(query) {
  const filtros = new URLSearchParams(query);
  if (!filtros.has('mes')) filtros.set('mes', hoje().slice(0, 7));
  const [lista, empresas, equipe] = await Promise.all([
    api(`/api/solicitacoes?status=emitida&${filtros}`),
    api('/api/empresas'),
    equipeDoEscritorio(),
  ]);
  const total = lista.reduce((t, s) => t + (s.valor_centavos ?? 0), 0);

  const excluir = async (s) => {
    try {
      if (await excluirNota(s)) rotear();
    } catch (err) {
      avisar(err.message, 'erro');
    }
  };

  renderizar(
    h('div', { class: 'cabecalho-pagina' },
      h('h1', {}, 'Notas emitidas'),
      h('div', { class: 'acoes', style: { marginTop: 0 } },
        h('a', { class: 'botao secundario', href: `/api/solicitacoes.csv?status=emitida&${filtros}` }, 'Exportar CSV'),
        h('button', { class: 'secundario', onclick: abrirLoteXml }, 'Lançar XMLs em lote'),
        h('button', { class: 'destaque', onclick: () => abrirDialogoNota() }, '+ Registrar nota'))),
    h('form', {
      class: 'filtros',
      onsubmit: (ev) => {
        ev.preventDefault();
        const d = dadosFormulario(ev.target);
        const novo = new URLSearchParams();
        for (const [k, v] of Object.entries(d)) if (v || k === 'mes') novo.set(k, v);
        location.hash = `#/notas?${novo}`;
      },
    },
    campo('Mês de emissão', { type: 'month', name: 'mes', valor: filtros.get('mes') }),
    campo('Empresa', { tag: 'select', name: 'empresa_id', valor: filtros.get('empresa_id'), opcoes: [['', 'Todas'], ...empresas.map((e) => [e.id, e.razao_social])] }),
    campo('Responsável', { tag: 'select', name: 'responsavel_id', valor: filtros.get('responsavel_id'), opcoes: [['', 'Todos'], ...equipe.map((u) => [u.id, u.nome])] }),
    campo('Canal', { tag: 'select', name: 'canal', valor: filtros.get('canal'), opcoes: [['', 'Todos'], ...Object.entries(opcoes.canais)] }),
    campo('Busca', { type: 'search', name: 'busca', valor: filtros.get('busca'), placeholder: 'Nº, tomador, descrição…' }),
    h('button', { type: 'submit', class: 'secundario' }, 'Filtrar'),
    h('a', { href: '#/notas?mes=', class: 'botao secundario' }, 'Ver todos os meses')),
    lista.length
      ? h('div', {},
        h('p', { class: 'suave' }, `${lista.length} nota(s)${total ? ` · ${moeda(total)}` : ''}`),
        h('div', { class: 'tabela' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Emissão', 'Empresa', 'Nº', 'Tomador', 'Valor', 'Pedido', 'Arquivos', ''].map((t) => h('th', { class: t === 'Valor' ? 'num' : null }, t)))),
          h('tbody', {}, lista.map((s) => h('tr', {},
            h('td', {}, data(s.data_nota)),
            h('td', {}, h('a', { href: `#/empresa/${s.empresa_id}` }, s.empresa_nome)),
            h('td', {}, h('a', { href: `#/solicitacao/${s.id}` }, h('strong', {}, s.numero_nota ?? '—'))),
            h('td', {}, s.tomador_nome ?? h('span', { class: 'suave' }, '—'), s.tomador_documento ? h('div', { class: 'suave' }, documento(s.tomador_documento)) : null),
            h('td', { class: 'num' }, s.valor_centavos ? moeda(s.valor_centavos) : '—'),
            h('td', {}, descricaoPedido(s)),
            h('td', {}, s.anexos ? `${s.anexos} arquivo(s)` : h('span', { class: 'suave' }, 'sem anexo')),
            h('td', {}, h('div', { class: 'acoes', style: { marginTop: 0, flexWrap: 'nowrap' } },
              h('button', { class: 'secundario', onclick: () => abrirEdicaoNota(s.id) }, 'Editar'),
              h('button', { class: 'secundario', onclick: () => excluir(s) }, 'Excluir')))))))))
      : h('div', { class: 'cartao vazio' }, 'Nenhuma nota neste filtro. Use "Registrar nota" ou "Lançar XMLs em lote".'));
}

// ---------------------------------------------------------------------------
// Dashboard (visão geral do escritório)
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

// Igual a h(), para elementos SVG (gráficos e ícones).
function svg(tag, atributos = {}, ...filhos) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [chave, valor] of Object.entries(atributos)) if (valor != null && valor !== false) el.setAttribute(chave, valor);
  for (const filho of filhos.flat(Infinity)) {
    if (filho == null || filho === false) continue;
    el.append(filho instanceof Node ? filho : document.createTextNode(String(filho)));
  }
  return el;
}

const mesAbreviado = (m) => new Date(`${m}-15T12:00:00`).toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');

// Colunas por mês (uma ou mais séries lado a lado), com o valor sobre cada coluna, dica ao
// passar o mouse e a tabela com os números logo abaixo.
function graficoColunas({ meses, series }) {
  const largura = 520;
  const altura = 200;
  const topo = 20;
  const base = 24;
  const util = altura - topo - base;
  const maximo = Math.max(1, ...series.flatMap((x) => x.valores));
  const grupo = largura / meses.length;
  const vao = 2;
  const barra = Math.min(30, (grupo * 0.62 - vao * (series.length - 1)) / series.length);
  const larguraGrupo = barra * series.length + vao * (series.length - 1);

  const colunas = meses.flatMap((m, i) => series.map((serie, j) => {
    const valor = serie.valores[i];
    const x = i * grupo + (grupo - larguraGrupo) / 2 + j * (barra + vao);
    const alturaBarra = (valor / maximo) * util;
    const y = altura - base - alturaBarra;
    const r = Math.min(4, alturaBarra, barra / 2);
    const fundo = altura - base;
    return svg('g', { class: 'coluna' },
      svg('title', {}, `${serie.nome} · ${nomeDoMes(m)}: ${valor}`),
      // Área de toque maior que a coluna, para a dica aparecer mesmo em colunas baixas.
      svg('rect', { x: x - vao, y: topo, width: barra + vao * 2, height: util, fill: 'transparent' }),
      valor > 0 ? svg('path', {
        d: `M${x},${fundo} V${y + r} Q${x},${y} ${x + r},${y} H${x + barra - r} Q${x + barra},${y} ${x + barra},${y + r} V${fundo} Z`,
        fill: serie.cor,
      }) : null,
      valor > 0 ? svg('text', { x: x + barra / 2, y: y - 6, 'text-anchor': 'middle', class: 'valor' }, valor) : null);
  }));

  return h('div', { class: 'grafico' },
    series.length > 1
      ? h('div', { class: 'legenda-grafico' }, series.map((serie) => h('span', {}, h('i', { style: { background: serie.cor } }), serie.nome)))
      : null,
    svg('svg', { viewBox: `0 0 ${largura} ${altura}`, role: 'img', 'aria-label': series.map((x) => x.nome).join(' e ') },
      svg('line', { x1: 0, x2: largura, y1: altura - base, y2: altura - base, class: 'eixo' }),
      colunas,
      meses.map((m, i) => svg('text', { x: i * grupo + grupo / 2, y: altura - 6, 'text-anchor': 'middle', class: 'mes' }, mesAbreviado(m)))),
    h('details', { class: 'ver-numeros' }, h('summary', {}, 'Ver os números'),
      h('table', { class: 'manter' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Mês'), series.map((x) => h('th', { class: 'num' }, x.nome)))),
        h('tbody', {}, meses.map((m, i) => h('tr', {}, h('td', {}, nomeDoMes(m)), series.map((x) => h('td', { class: 'num' }, x.valores[i]))))))));
}

async function telaDashboard(query) {
  const filtros = new URLSearchParams(query);
  const mes = filtros.get('mes') || hoje().slice(0, 7);
  const p = await api(`/api/painel?mes=${mes}`);
  const [ano, numMes] = mes.split('-').map(Number);
  const periodo = `inicio=${mes}-01&fim=${mes}-${String(new Date(ano, numMes, 0).getDate()).padStart(2, '0')}`;

  const indicador = (numero, rotulo, detalhe, cor, href) => h('div', {
    class: 'indicador', style: { '--cor': cor, cursor: href ? 'pointer' : 'default' }, onclick: href ? () => { location.hash = href; } : null,
  }, h('div', { class: 'rotulo' }, rotulo), h('div', { class: 'numero' }, numero), detalhe ? h('div', { class: 'suave' }, detalhe) : null);

  const maiorRegime = Math.max(1, ...p.clientes.por_regime.map((r) => r.quantidade));

  renderizar(
    h('div', { class: 'cabecalho-pagina' },
      h('div', {}, h('h1', {}, 'Visão geral'), h('div', { class: 'suave' }, `Indicadores de ${nomeDoMes(mes)}`)),
      h('form', {
        class: 'filtros', style: { marginBottom: 0 },
        onsubmit: (ev) => { ev.preventDefault(); filtrosNaUrl('', dadosFormulario(ev.target)); },
        onchange: (ev) => ev.currentTarget.requestSubmit(),
      }, campo('Mês', { type: 'month', name: 'mes', valor: mes }))),
    h('div', { class: 'acoes-rapidas' },
      h('button', { class: 'acao-rapida destaque', onclick: () => abrirDialogoNota() },
        h('strong', {}, 'Registrar nota'), h('span', {}, 'Com XML, os dados são lidos sozinhos')),
      h('button', { class: 'acao-rapida roxo', onclick: () => abrirDialogoOcorrencia('guia_recalculada') },
        h('strong', {}, 'Guia recalculada'), h('span', {}, 'Com a guia anexada')),
      h('button', { class: 'acao-rapida escuro', onclick: () => abrirDialogoOcorrencia('multa') },
        h('strong', {}, 'Multa'), h('span', {}, 'Com a guia e o motivo')),
      h('button', { class: 'acao-rapida', onclick: () => abrirFormularioEmpresa() },
        h('strong', {}, 'Novo cliente'), h('span', {}, 'Cadastro com regime e honorário'))),
    h('div', { class: 'indicadores seis' },
      indicador(p.clientes.ativos, 'Clientes ativos',
        `${p.clientes.novos_no_mes} novo(s) no mês · ${p.clientes.inativos} inativo(s)`, 'var(--azul)', '#/empresas'),
      indicador(moeda(p.honorarios.base_mensal_centavos), 'Honorários mensais (base)',
        `Ticket médio ${moeda(p.honorarios.ticket_medio_centavos)}`, 'var(--rosa)', null),
      indicador(p.operacao.notas_emitidas, 'Notas emitidas no mês',
        `${p.operacao.notas_abertas} pedido(s) em aberto`, 'var(--azul-claro)', `#/notas?mes=${mes}`),
      indicador(p.operacao.guias, 'Guias recalculadas no mês', null, 'var(--roxo)', `#/ocorrencias?tipo=guia_recalculada&${periodo}`),
      indicador(p.operacao.multas, 'Multas no mês',
        `${moeda(p.operacao.multas_valor_centavos)} · ${p.operacao.multas_escritorio} por causa do escritório`, 'var(--preto)',
        `#/ocorrencias?tipo=multa&${periodo}`),
      indicador(p.zen.recebidos_no_mes, 'Documentos do Questor Zen no mês',
        p.zen.sem_empresa ? `${p.zen.sem_empresa} sem empresa associada` : 'Todos associados', 'var(--azul)', '#/zen')),
    h('div', { class: 'colunas-iguais' },
      h('div', { class: 'cartao' },
        h('h2', {}, 'Notas emitidas nos últimos 6 meses'),
        graficoColunas({ meses: p.meses, series: [{ nome: 'Notas emitidas', cor: 'var(--azul)', valores: p.serie.map((x) => x.notas) }] })),
      h('div', { class: 'cartao' },
        h('h2', {}, 'Guias recalculadas e multas'),
        graficoColunas({
          meses: p.meses,
          series: [
            { nome: 'Guias recalculadas', cor: 'var(--roxo)', valores: p.serie.map((x) => x.guias) },
            { nome: 'Multas', cor: 'var(--rosa)', valores: p.serie.map((x) => x.multas) },
          ],
        }))),
    h('div', { class: 'colunas-iguais' },
      h('div', { class: 'cartao' },
        h('h2', {}, 'Clientes ativos por regime'),
        p.clientes.por_regime.length
          ? h('div', { class: 'rolagem-x' }, h('table', { class: 'manter' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Regime'), h('th', { class: 'num' }, 'Clientes'), h('th', { class: 'num' }, 'Honorários/mês'))),
            h('tbody', {}, p.clientes.por_regime.map((r) => h('tr', {},
              h('td', {}, r.rotulo, h('div', { class: 'barra' }, h('span', { style: { width: `${Math.round((r.quantidade / maiorRegime) * 100)}%` } }))),
              h('td', { class: 'num' }, h('strong', {}, r.quantidade)),
              h('td', { class: 'num' }, moeda(r.honorarios_centavos)))))))
          : h('p', { class: 'suave' }, 'Nenhum cliente ativo cadastrado.')),
      h('div', { class: 'cartao' },
        h('h2', {}, 'Pendências'),
        p.alertas.length
          ? h('ul', { class: 'pendencias' }, p.alertas.map((a) => h('li', {},
            h('a', { href: a.link }, h('strong', {}, a.quantidade), ` ${a.texto}`))))
          : h('p', { class: 'suave' }, 'Nada pendente. Cadastros completos e nenhum pedido de nota em aberto.'))));
}

async function carregarUsuario() {
  try {
    usuario = await api('/api/me');
    opcoes = await api('/api/opcoes');
  } catch {
    usuario = null;
  }
}

// Ícones do menu (traço simples, 24×24).
const ICONES = {
  inicio: [['rect', { x: 3, y: 3, width: 7, height: 9, rx: 1.5 }], ['rect', { x: 14, y: 3, width: 7, height: 5, rx: 1.5 }],
    ['rect', { x: 14, y: 12, width: 7, height: 9, rx: 1.5 }], ['rect', { x: 3, y: 16, width: 7, height: 5, rx: 1.5 }]],
  painel: [['polyline', { points: '22 12 18 12 15 21 9 3 6 12 2 12' }]],
  nota: [['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }], ['polyline', { points: '14 2 14 8 20 8' }],
    ['line', { x1: 8, y1: 13, x2: 16, y2: 13 }], ['line', { x1: 8, y1: 17, x2: 13, y2: 17 }]],
  alerta: [['path', { d: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z' }],
    ['line', { x1: 12, y1: 9, x2: 12, y2: 13 }], ['line', { x1: 12, y1: 17, x2: 12.01, y2: 17 }]],
  grafico: [['line', { x1: 18, y1: 20, x2: 18, y2: 10 }], ['line', { x1: 12, y1: 20, x2: 12, y2: 4 }], ['line', { x1: 6, y1: 20, x2: 6, y2: 14 }]],
  clientes: [['rect', { x: 2, y: 7, width: 20, height: 14, rx: 2 }], ['path', { d: 'M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16' }]],
  usuarios: [['path', { d: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' }], ['circle', { cx: 9, cy: 7, r: 4 }],
    ['path', { d: 'M23 21v-2a4 4 0 0 0-3-3.87' }], ['path', { d: 'M16 3.13a4 4 0 0 1 0 7.75' }]],
  documentos: [['polyline', { points: '22 12 16 12 14 15 10 15 8 12 2 12' }],
    ['path', { d: 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z' }]],
  nova: [['circle', { cx: 12, cy: 12, r: 10 }], ['line', { x1: 12, y1: 8, x2: 12, y2: 16 }], ['line', { x1: 8, y1: 12, x2: 16, y2: 12 }]],
};

const icone = (nome) => svg('svg', { viewBox: '0 0 24 24', class: 'icone', 'aria-hidden': 'true' },
  ICONES[nome].map(([tag, atributos]) => svg(tag, atributos)));

// Menu lateral agrupado por seção; cada item: [href, texto, ícone].
function itensDoMenu() {
  if (usuario.papel === 'escritorio') {
    return [
      ['Visão geral', [['#/', 'Dashboard', 'inicio'], ['#/painel-notas', 'Painel de notas', 'painel']]],
      ['Operação', [['#/notas', 'Notas', 'nota'], ['#/ocorrencias', 'Guias e multas', 'alerta'], ['#/relatorio', 'Relatório', 'grafico']]],
      ['Cadastros', [['#/empresas', 'Clientes', 'clientes'], ['#/usuarios', 'Usuários', 'usuarios']]],
      ['Integrações', [['#/zen', 'Questor Zen', 'documentos']]],
    ];
  }
  return [[null, opcoes.acesso_clientes
    ? [['#/', 'Minhas solicitações', 'nota'], ['#/nova', 'Nova solicitação', 'nova'], ['#/documentos', 'Meus documentos', 'documentos']]
    : [['#/', 'Meus documentos', 'documentos']]]];
}

function montarMenu(caminho) {
  const ativo = (href) => {
    if (href === '#/') return caminho === '/' || (usuario.papel !== 'escritorio' && caminho.startsWith('/solicitacao'));
    if (href === '#/notas') return caminho === '/notas' || caminho.startsWith('/solicitacao');
    if (href === '#/empresas') return caminho === '/empresas' || caminho.startsWith('/empresa/');
    return `#${caminho}` === href;
  };
  document.getElementById('menu').replaceChildren(...itensDoMenu().map(([secao, itens]) => h('div', { class: 'secao-menu' },
    secao ? h('div', { class: 'titulo-secao' }, secao) : null,
    itens.map(([href, texto, nomeIcone]) => h('a', { href, class: ativo(href) ? 'ativo' : null }, icone(nomeIcone), texto)))));
  document.body.classList.remove('menu-aberto');
  document.getElementById('nome-usuario').textContent = usuario.empresa
    ? `${usuario.nome} · ${usuario.empresa.razao_social}`
    : usuario.nome;
  document.body.classList.remove('tela-login');
  document.body.classList.add('com-lateral');
  document.getElementById('topo').hidden = false;
  document.getElementById('faixa-marca').hidden = false;
}

async function rotear() {
  const [caminho, query = ''] = location.hash.slice(1).split('?');
  if (!usuario) await carregarUsuario();
  if (!usuario) return telaLogin();
  montarMenu(caminho || '/');
  const escritorio = usuario.papel === 'escritorio';

  try {
    let m;
    if (!caminho || caminho === '/') {
      if (escritorio) return await telaDashboard(query);
      return opcoes.acesso_clientes ? await telaSolicitacoesCliente(query) : await telaPortalDocumentos();
    }
    if (caminho === '/login') { location.hash = '#/'; return; }
    if (caminho === '/senha') return telaSenha();
    if (caminho === '/documentos' && !escritorio) return await telaPortalDocumentos();
    if (caminho === '/zen' && escritorio) return await telaZen();
    if (!escritorio && !opcoes.acesso_clientes) { location.hash = '#/'; return; }
    if (caminho === '/nova') return await telaFormulario(null);
    if ((m = caminho.match(/^\/solicitacao\/(\d+)\/editar$/))) return await telaFormulario(m[1]);
    if ((m = caminho.match(/^\/solicitacao\/(\d+)$/))) return await telaDetalhe(m[1]);
    if (caminho === '/notas' && escritorio) return await telaNotas(query);
    if (caminho === '/painel-notas' && escritorio) return await telaPainelMes(query);
    if (caminho === '/empresas' && escritorio) return await telaEmpresas();
    if (caminho === '/usuarios' && escritorio) return await telaUsuarios();
    if (caminho === '/ocorrencias' && escritorio) return await telaOcorrencias(query);
    if (caminho === '/relatorio' && escritorio) return await telaRelatorio(query);
    if ((m = caminho.match(/^\/empresa\/(\d+)$/)) && escritorio) return await telaPerfilEmpresa(m[1], query);
    if (caminho === '/senha') return telaSenha();
    renderizar(h('div', { class: 'cartao vazio' }, 'Página não encontrada. ', h('a', { href: '#/' }, 'Voltar ao início')));
  } catch (err) {
    if (usuario) renderizar(h('div', { class: 'alerta erro' }, err.message));
  }
}

document.getElementById('abrir-menu').addEventListener('click', () => {
  const aberto = document.body.classList.toggle('menu-aberto');
  document.getElementById('abrir-menu').setAttribute('aria-expanded', String(aberto));
});

document.getElementById('sair').addEventListener('click', async () => {
  await api('/api/logout', { metodo: 'POST', dados: {} }).catch(() => {});
  usuario = null;
  location.hash = '#/login';
});

window.addEventListener('hashchange', rotear);
rotear();
