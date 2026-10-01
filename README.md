# Gestão de Solicitações de Notas Fiscais

Sistema web para escritórios de contabilidade receberem, acompanharem e responderem
os pedidos de emissão de notas fiscais dos seus clientes.

- **Clientes** entram no sistema, preenchem o pedido de nota (tomador, valor, descrição,
  competência), acompanham o andamento e baixam o PDF/XML quando a nota é emitida.
- **O escritório** vê todas as solicitações num painel, assume a emissão, informa o número
  da nota, anexa os arquivos, rejeita pedidos com dados faltando e conversa com o cliente.

## Como rodar

Requisito: **Node.js 22.13 ou superior**. Não há dependências externas (usa o SQLite
embutido no Node).

```bash
npm start
```

Acesse <http://localhost:3000>. Na primeira execução o sistema cria o usuário
administrador e mostra a senha no terminal. Para definir os dados do administrador:

```bash
ADMIN_EMAIL=voce@seuescritorio.com.br ADMIN_SENHA='uma-senha-forte' npm start
```

### Variáveis de ambiente

| Variável        | Padrão                     | Descrição                                          |
|-----------------|----------------------------|----------------------------------------------------|
| `PORT`          | `3000`                     | Porta HTTP                                         |
| `DATA_DIR`      | `./data`                   | Pasta do banco (`notas.db`) e dos anexos           |
| `ADMIN_EMAIL`   | `admin@escritorio.com.br`  | E-mail do primeiro administrador                   |
| `ADMIN_SENHA`   | (gerada aleatoriamente)    | Senha do primeiro administrador                    |
| `COOKIE_SEGURO` | —                          | Use `1` em produção com HTTPS                      |

### Testes

```bash
npm test
```

## Primeiros passos

1. Entre como administrador e troque a senha (**Trocar senha**).
2. Em **Empresas**, cadastre cada cliente do escritório (razão social e CNPJ).
3. Em **Usuários**, crie o acesso das pessoas de cada empresa (perfil *Cliente*) e da
   sua equipe (perfil *Escritório*). Envie o e-mail e a senha inicial para cada um.
4. Os clientes passam a abrir as solicitações pelo sistema.

## Fluxo de uma solicitação

```
            ┌──────────── rejeitada ◄──────────┐
            │  (cliente corrige e reenvia)     │
            ▼                                  │
  ──► pendente ──► em emissão ──► emitida      │
         │  └───────────┴──────────────────────┘
         └──► cancelada  (cliente ou escritório)
```

| Status       | Significado                                         | Quem muda                    |
|--------------|-----------------------------------------------------|------------------------------|
| Pendente     | Pedido recebido, aguardando o escritório             | —                            |
| Em emissão   | Alguém do escritório assumiu o pedido                | Escritório                   |
| Emitida      | Nota emitida (número obrigatório; anexe PDF/XML)     | Escritório                   |
| Rejeitada    | Faltam dados; o motivo é mostrado ao cliente         | Escritório                   |
| Cancelada    | Pedido desistido (cliente precisa informar o motivo) | Cliente ou escritório        |

Toda mudança, edição, anexo e mensagem fica registrada no histórico da solicitação.

## Controle operacional (out–dez/2026) e reajustes de janeiro

Área exclusiva do escritório para juntar os dados que embasam reajustes de plano,
upsell e melhoria do serviço.

1. **Plano de cada cliente** (menu *Empresas* → *Editar*): se tem plano de emissão de
   notas, nome do plano, quantas notas estão incluídas por mês e o honorário mensal atual.
2. **Ocorrências** (menu *Ocorrências*): registre cada **guia recalculada** e cada **multa**
   recebida, com motivo, data, valor e a **causa** (cliente, escritório ou outro).
   - Motivos de multa: falta de declaração, declaração em atraso, guia enviada após o
     vencimento, pagamento em atraso pelo cliente, outro.
   - Motivos de recálculo: cliente pagou após o vencimento, guia enviada após o vencimento,
     informações enviadas em atraso, retificação, outro.
3. **Notas solicitadas**: contadas automaticamente a partir das solicitações (pela data do
   pedido, sem as canceladas). Pedidos que chegam por WhatsApp/e-mail devem ser lançados
   pela equipe em *Nova solicitação*, escolhendo a empresa, para entrarem na contagem.
4. **Relatório** (menu *Relatório*, período padrão 01/10/2026 a 31/12/2026): por cliente,
   notas mês a mês (destacando meses acima da franquia), média mensal, guias, multas e
   alertas:
   - *Oportunidade de plano*: cliente sem plano com média de 2+ notas/mês, ou com plano que
     passou da franquia em algum mês;
   - *Atenção com o cliente*: recálculos ou multas causados pelo cliente;
   - *Qualidade interna*: recálculos ou multas causados pelo escritório.

   O botão **Exportar CSV** gera a planilha completa para abrir no Excel.

## Lançamento automático pelo perfil do cliente

Em *Empresas* → **Abrir perfil**, cada cliente tem um painel do período (notas por mês,
guias, multas e alertas) e três botões:

- **Registrar nota emitida**: anexe o XML e/ou o PDF. Com o XML, o sistema lê sozinho
  número, data, valor, tomador e descrição (NF-e, NFS-e Padrão Nacional e NFS-e ABRASF),
  confere se o emitente é mesmo aquele cliente e, se houver uma solicitação em aberto
  do mesmo tomador e valor, já a marca como emitida. Sem solicitação, a nota entra como
  nova. Notas repetidas (mesmo número) são recusadas. O painel e o relatório contam a
  nota no mês da emissão.
- **Registrar guia recalculada**: anexe a nova guia e informe tributo, competência,
  motivo, causa e o acréscimo pago.
- **Registrar multa**: anexe a guia/notificação da multa e informe tributo, motivo,
  causa e valor.

No **Painel** há também o botão *Registrar nota emitida (XML)*, que identifica o cliente
pelo CNPJ do emitente sem precisar abrir o perfil.

## Funcionalidades

- Login com perfis **Escritório** e **Cliente**; cada cliente só vê as solicitações da
  própria empresa.
- Validação de CPF/CNPJ, valores em reais (`1.234,56`) e datas.
- Painel com totais por status (quantidade e valor), filtros por empresa, status,
  mês de competência e busca livre.
- Exportação das solicitações filtradas em **CSV** (abre direto no Excel).
- Anexos PDF, XML, PNG e JPG (até 10 MB) com download controlado por permissão.
- Mensagens entre cliente e escritório dentro de cada solicitação.

## Estrutura

```
src/
  server.js     inicialização do servidor e criação do admin
  app.js        rotas da API e regras de negócio (fluxo de status, permissões)
  db.js         esquema do banco SQLite
  auth.js       senhas (scrypt), sessões e cookies
  validacao.js  CPF/CNPJ, valores e validação das solicitações
  operacional.js ocorrências (guias recalculadas e multas) e relatório por cliente
  csv.js        geração de planilhas CSV
  xmlNota.js    leitura de XML de NF-e e NFS-e
  arquivos.js   validação e gravação de anexos
public/         interface web (HTML/CSS/JS, sem build)
test/           testes automatizados (node --test)
```

## Segurança

- Senhas com `scrypt` e sal aleatório; sessões em cookie `HttpOnly` + `SameSite=Strict`.
- Requisições que alteram dados exigem `Content-Type: application/json` (proteção CSRF).
- Cabeçalhos de segurança (CSP, `X-Frame-Options`, `nosniff`); a interface monta o HTML
  sem `innerHTML`, evitando XSS.
- Arquivos anexados são salvos com nome aleatório, fora da pasta pública.

Em produção, rode atrás de um proxy com HTTPS (nginx, Caddy etc.), defina
`COOKIE_SEGURO=1` e faça backup periódico da pasta `DATA_DIR`.

## Próximos passos sugeridos

- Notificação por e-mail/WhatsApp ao cliente quando a nota for emitida ou rejeitada.
- Cadastro de tomadores frequentes para preenchimento automático.
- Integração com a prefeitura / emissor de NFS-e para emissão automática.
