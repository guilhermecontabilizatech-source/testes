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
  renderizar(h('div', { class: 'cartao login' },
    h('h1', {}, 'Solicitações de Notas Fiscais'),
    h('p', { class: 'suave' }, 'Acesse com o e-mail e a senha fornecidos pelo escritório.'),
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
    h('div', { class: 'acoes' }, h('button', { type: 'submit' }, 'Entrar')))));
}

async function telaPainel(query) {
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
      h('h1', {}, `Solicitação #${s.id} `, etiqueta(s.status)),
      h('a', { href: '#/' }, '← Voltar para a lista')),
    s.status === 'rejeitada' && h('div', { class: 'alerta erro' }, h('strong', {}, 'Rejeitada: '), s.motivo_rejeicao,
      !ehEscritorio && h('div', {}, 'Clique em "Corrigir e reenviar" para ajustar os dados.')),
    s.status === 'emitida' && h('div', { class: 'alerta sucesso' }, h('strong', {}, `Nota nº ${s.numero_nota} emitida.`),
      s.anexos.length ? ' Os arquivos estão disponíveis em "Anexos".' : ''),
    h('div', { class: 'colunas' },
      h('div', {},
        h('div', { class: 'cartao' },
          h('h2', {}, 'Dados da nota'),
          h('dl', { class: 'detalhes' },
            item('Empresa emissora', `${s.empresa_nome} (${documento(s.empresa_cnpj)})`),
            item('Tipo', s.tipo_nota),
            item('Valor', moeda(s.valor_centavos)),
            item('Competência', data(s.data_competencia)),
            item('Nº da nota', s.numero_nota),
            item('Responsável no escritório', s.responsavel_nome),
            item('Descrição', s.descricao, true))),
        h('div', { class: 'cartao' },
          h('h2', {}, 'Tomador'),
          h('dl', { class: 'detalhes' },
            item('Nome / Razão social', s.tomador_nome),
            item('CPF/CNPJ', documento(s.tomador_documento)),
            item('E-mail', s.tomador_email),
            item('Endereço', s.tomador_endereco, true),
            item('Observações', s.observacoes, true))),
        h('div', { class: 'cartao' },
          h('h2', {}, 'Ações'),
          h('div', { class: 'acoes', style: { marginTop: 0 } },
            s.editavel && h('a', { class: 'botao', href: `#/solicitacao/${s.id}/editar` },
              s.status === 'rejeitada' ? 'Corrigir e reenviar' : 'Editar'),
            s.transicoes.map((destino) => h('button', {
              class: ACOES_STATUS[destino].classe,
              onclick: () => dialogoStatus(s, destino),
            }, ACOES_STATUS[destino].rotulo)),
            !s.editavel && !s.transicoes.length && h('span', { class: 'suave' }, 'Nenhuma ação disponível.')))),
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
          h('h2', {}, 'Histórico e mensagens'),
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
          campo('Enviar mensagem', { tag: 'textarea', name: 'mensagem', required: true, maxlength: 2000, placeholder: 'Escreva uma dúvida ou observação…' }),
          h('div', { class: 'acoes', style: { marginTop: '8px' } }, h('button', { type: 'submit', class: 'secundario' }, 'Enviar')))))));
}

async function telaEmpresas() {
  const empresas = await api('/api/empresas');

  const abrirFormulario = (e = {}) => {
    const dialogo = h('dialog', {},
      h('form', {
        onsubmit: aoEnviar(async (dados) => {
          const corpo = { ...dados, ativo: dados.ativo === '1' };
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
        campo('Situação', { tag: 'select', name: 'ativo', valor: e.ativo === 0 ? '0' : '1', opcoes: [['1', 'Ativa'], ['0', 'Inativa']] })),
      h('div', { class: 'acoes' },
        h('button', { type: 'submit' }, 'Salvar'),
        h('button', { type: 'button', class: 'secundario', onclick: () => dialogo.close() }, 'Cancelar'))));
    dialogo.addEventListener('close', () => dialogo.remove());
    document.body.append(dialogo);
    dialogo.showModal();
  };

  renderizar(
    h('div', { class: 'cabecalho-pagina' },
      h('h1', {}, 'Empresas clientes'),
      h('button', { onclick: () => abrirFormulario() }, '+ Nova empresa')),
    empresas.length
      ? h('div', { class: 'tabela' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Razão social', 'CNPJ', 'Contato', 'Usuários', 'Em aberto', 'Situação', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, empresas.map((e) => h('tr', {},
          h('td', {}, e.razao_social),
          h('td', {}, documento(e.cnpj)),
          h('td', {}, e.email ?? '', h('div', { class: 'suave' }, e.telefone ?? '')),
          h('td', {}, e.usuarios),
          h('td', {}, h('a', { href: `#/?empresa_id=${e.id}` }, e.abertas)),
          h('td', {}, e.ativo ? 'Ativa' : 'Inativa'),
          h('td', {}, h('button', { class: 'secundario', onclick: () => abrirFormulario(e) }, 'Editar')))))))
      : h('div', { class: 'cartao vazio' }, 'Cadastre a primeira empresa cliente para começar.'));
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
  h('h2', {}, 'Novo usuário'),
  h('div', { class: 'grade' },
    campo('Nome *', { name: 'nome', required: true }),
    campo('E-mail *', { type: 'email', name: 'email', required: true }),
    campo('Senha inicial *', { type: 'text', name: 'senha', required: true, minlength: 8, autocomplete: 'new-password' }),
    campo('Perfil', { tag: 'select', name: 'papel', opcoes: [['cliente', 'Cliente (empresa)'], ['escritorio', 'Equipe do escritório']] }),
    campo('Empresa (para clientes)', { tag: 'select', name: 'empresa_id', opcoes: [['', '—'], ...empresas.map((e) => [e.id, e.razao_social])] })),
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

async function carregarUsuario() {
  try {
    usuario = await api('/api/me');
  } catch {
    usuario = null;
  }
}

function montarMenu(caminho) {
  const itens = [['#/', 'Solicitações'], ['#/nova', 'Nova solicitação']];
  if (usuario.papel === 'escritorio') itens.push(['#/empresas', 'Empresas'], ['#/usuarios', 'Usuários']);
  document.getElementById('menu').replaceChildren(...itens.map(([href, texto]) => h('a', {
    href, class: (href === '#/' ? caminho === '/' || caminho.startsWith('/solicitacao') : `#${caminho}` === href) ? 'ativo' : null,
  }, texto)));
  document.getElementById('nome-usuario').textContent = usuario.empresa
    ? `${usuario.nome} · ${usuario.empresa.razao_social}`
    : `${usuario.nome} · Escritório`;
  document.getElementById('topo').hidden = false;
}

async function rotear() {
  const [caminho, query = ''] = location.hash.slice(1).split('?');
  if (!usuario) await carregarUsuario();
  if (!usuario) return telaLogin();
  montarMenu(caminho || '/');

  try {
    let m;
    if (!caminho || caminho === '/') return await telaPainel(query);
    if (caminho === '/login') { location.hash = '#/'; return; }
    if (caminho === '/nova') return await telaFormulario(null);
    if ((m = caminho.match(/^\/solicitacao\/(\d+)\/editar$/))) return await telaFormulario(m[1]);
    if ((m = caminho.match(/^\/solicitacao\/(\d+)$/))) return await telaDetalhe(m[1]);
    if (caminho === '/empresas' && usuario.papel === 'escritorio') return await telaEmpresas();
    if (caminho === '/usuarios' && usuario.papel === 'escritorio') return await telaUsuarios();
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
