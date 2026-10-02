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
let opcoes = { canais: {}, acesso_clientes: false };
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

async function abrirFormularioEmpresa(e = {}) {
  const equipe = await equipeDoEscritorio();
  const dialogo = abrirDialogo(h('form', {
    onsubmit: aoEnviar(async (dados) => {
      const corpo = { ...dados, ativo: dados.ativo === '1', plano_notas: dados.plano_notas === '1' };
      if (e.id) await api(`/api/empresas/${e.id}`, { metodo: 'PUT', dados: corpo });
      else await api('/api/empresas', { metodo: 'POST', dados: corpo });
      dialogo.close();
      avisar('Empresa salva.');
      rotear();
    }),
  },
  h('h2', {}, e.id ? 'Editar empresa' : 'Nova empresa cliente'),
  h('div', { class: 'grade' },
    campo('Razão social *', { name: 'razao_social', required: true, valor: e.razao_social }, { inteira: true }),
    campo('CNPJ *', { name: 'cnpj', required: true, valor: documento(e.cnpj) }),
    campo('Telefone', { name: 'telefone', valor: e.telefone }),
    campo('E-mail', { type: 'email', name: 'email', valor: e.email }, { inteira: true }),
    campo('Responsável no escritório', { tag: 'select', name: 'responsavel_id', valor: e.responsavel_id ?? '', opcoes: [['', '—'], ...equipe.map((u) => [u.id, u.nome])] }),
    campo('Situação', { tag: 'select', name: 'ativo', valor: e.ativo === 0 ? '0' : '1', opcoes: [['1', 'Ativa'], ['0', 'Inativa']] }),
    campo('Honorário mensal (R$)', { name: 'honorario', inputmode: 'decimal', placeholder: '0,00', valor: reaisCampo(e.honorario_centavos) })),
  h('h3', {}, 'Plano de emissão de notas'),
  h('div', { class: 'grade' },
    campo('Tem plano de notas?', { tag: 'select', name: 'plano_notas', valor: e.plano_notas ? '1' : '0', opcoes: [['0', 'Não'], ['1', 'Sim']] }),
    campo('Notas incluídas por mês', { type: 'number', name: 'notas_incluidas', min: 0, step: 1, valor: e.notas_incluidas ?? '', placeholder: 'Deixe vazio se não houver limite' }),
    campo('Nome do plano', { name: 'plano_nome', maxlength: 100, valor: e.plano_nome, placeholder: 'Ex.: Simples Nacional — Essencial' }, { inteira: true })),
  h('div', { class: 'acoes' },
    h('button', { type: 'submit' }, 'Salvar'),
    h('button', { type: 'button', class: 'secundario', onclick: () => dialogo.close() }, 'Cancelar'))));
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
  renderizar(
    h('div', { class: 'cabecalho-pagina' },
      h('h1', {}, 'Empresas clientes'),
      h('div', { class: 'acoes', style: { marginTop: 0 } },
        h('button', { class: 'secundario', onclick: abrirImportacao }, 'Importar planilha ou PDF'),
        h('button', { onclick: () => abrirFormularioEmpresa() }, '+ Nova empresa'))),
    empresas.length
      ? h('div', { class: 'tabela' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Razão social', 'CNPJ', 'Plano de notas', 'Honorário', 'Responsável', 'Contato', 'Situação', ''].map((t) => h('th', { class: t === 'Honorário' ? 'num' : null }, t)))),
        h('tbody', {}, empresas.map((e) => h('tr', {},
          h('td', {}, h('a', { href: `#/empresa/${e.id}` }, e.razao_social)),
          h('td', {}, documento(e.cnpj)),
          h('td', {}, descricaoPlano(e)),
          h('td', { class: 'num' }, e.honorario_centavos == null ? '—' : moeda(e.honorario_centavos)),
          h('td', {}, e.responsavel_nome ?? h('span', { class: 'suave' }, '—')),
          h('td', {}, e.email ?? '', h('div', { class: 'suave' }, e.telefone ?? '')),
          h('td', {}, e.ativo ? 'Ativa' : 'Inativa'),
          h('td', {}, h('div', { class: 'acoes', style: { marginTop: 0 } },
            h('a', { class: 'botao', href: `#/empresa/${e.id}` }, 'Abrir perfil'),
            h('button', { class: 'secundario', onclick: () => abrirFormularioEmpresa(e) }, 'Editar'),
            h('button', { class: 'secundario', title: 'Excluir empresa', onclick: () => abrirExclusaoEmpresa(e) }, 'Excluir'))))))))
      : h('div', { class: 'cartao vazio' }, 'Cadastre a primeira empresa cliente ou importe uma planilha para começar.'));
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
        h('div', { class: 'suave' }, `CNPJ ${documento(e.cnpj)} · `, descricaoPlanoTexto(e),
          e.honorario_centavos != null ? ` · honorário ${moeda(e.honorario_centavos)}` : '',
          e.responsavel_nome ? ` · responsável: ${e.responsavel_nome}` : '')),
      h('div', { class: 'acoes', style: { marginTop: 0 } },
        h('button', { class: 'secundario', onclick: () => window.print() }, 'Imprimir ficha / PDF'),
        h('button', { class: 'secundario', onclick: () => abrirFormularioEmpresa(e) }, 'Editar cadastro'),
        h('button', { class: 'secundario', onclick: () => abrirExclusaoEmpresa(e, { aoExcluir: () => { location.hash = '#/empresas'; } }) }, 'Excluir empresa'),
        h('a', { href: '#/empresas' }, '← Empresas'))),
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
    opcoes.acesso_clientes
      ? [campo('Perfil', { tag: 'select', name: 'papel', opcoes: [['escritorio', 'Equipe do escritório'], ['cliente', 'Cliente (empresa)']] }),
        campo('Empresa (para clientes)', { tag: 'select', name: 'empresa_id', opcoes: [['', '—'], ...empresas.map((e) => [e.id, e.razao_social])] })]
      : h('input', { type: 'hidden', name: 'papel', value: 'escritorio' })),
  h('div', { class: 'acoes' }, h('button', { type: 'submit' }, 'Criar usuário')));

  const alternarAtivo = async (u) => {
    try {
      await api(`/api/usuarios/${u.id}`, { metodo: 'PUT', dados: { nome: u.nome, ativo: !u.ativo } });
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
        h('td', {}, u.papel === 'escritorio' ? 'Escritório' : 'Cliente'),
        h('td', {}, u.empresa_nome ?? '—'),
        h('td', {}, u.ativo ? 'Ativo' : 'Inativo'),
        h('td', {}, h('div', { class: 'acoes', style: { marginTop: 0 } },
          h('button', { class: 'secundario', onclick: () => redefinirSenha(u) }, 'Redefinir senha'),
          u.id !== usuario.id && h('button', { class: 'secundario', onclick: () => alternarAtivo(u) }, u.ativo ? 'Desativar' : 'Reativar')))))))));
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
      h('h1', {}, `Painel de ${nomeDoMes(mes)}`),
      h('form', {
        class: 'filtros', style: { marginBottom: 0 },
        onsubmit: (ev) => { ev.preventDefault(); filtrosNaUrl('', dadosFormulario(ev.target)); },
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
          ? h('table', {},
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
          ? h('table', {}, h('tbody', {}, maisNotas.map((e) => h('tr', {},
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

async function carregarUsuario() {
  try {
    usuario = await api('/api/me');
    opcoes = await api('/api/opcoes');
  } catch {
    usuario = null;
  }
}

function montarMenu(caminho) {
  const itens = usuario.papel === 'escritorio'
    ? [['#/', 'Painel'], ['#/notas', 'Notas'], ['#/ocorrencias', 'Ocorrências'], ['#/relatorio', 'Relatório'],
      ['#/empresas', 'Empresas'], ['#/usuarios', 'Usuários']]
    : [['#/', 'Minhas solicitações'], ['#/nova', 'Nova solicitação']];
  const ativo = (href) => {
    if (href === '#/') return caminho === '/' || (usuario.papel !== 'escritorio' && caminho.startsWith('/solicitacao'));
    if (href === '#/notas') return caminho === '/notas' || caminho.startsWith('/solicitacao');
    if (href === '#/empresas') return caminho === '/empresas' || caminho.startsWith('/empresa/');
    return `#${caminho}` === href;
  };
  document.getElementById('menu').replaceChildren(...itens.map(([href, texto]) => h('a', { href, class: ativo(href) ? 'ativo' : null }, texto)));
  document.getElementById('nome-usuario').textContent = usuario.empresa
    ? `${usuario.nome} · ${usuario.empresa.razao_social}`
    : usuario.nome;
  document.body.classList.remove('tela-login');
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
    if (!caminho || caminho === '/') return escritorio ? await telaPainelMes(query) : await telaSolicitacoesCliente(query);
    if (caminho === '/login') { location.hash = '#/'; return; }
    if (caminho === '/nova') return await telaFormulario(null);
    if ((m = caminho.match(/^\/solicitacao\/(\d+)\/editar$/))) return await telaFormulario(m[1]);
    if ((m = caminho.match(/^\/solicitacao\/(\d+)$/))) return await telaDetalhe(m[1]);
    if (caminho === '/notas' && escritorio) return await telaNotas(query);
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

document.getElementById('sair').addEventListener('click', async () => {
  await api('/api/logout', { metodo: 'POST', dados: {} }).catch(() => {});
  usuario = null;
  location.hash = '#/login';
});

window.addEventListener('hashchange', rotear);
rotear();
