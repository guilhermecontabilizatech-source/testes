# ContabilizaTech · Gestão do escritório

Sistema interno da ContabilizaTech para registrar as notas fiscais emitidas para os clientes
(pedidas por WhatsApp, e-mail etc.), as guias recalculadas e as multas, e acompanhar tudo por
cliente, mês e responsável, com a identidade visual da marca.

## Como a equipe usa no dia a dia

- **Painel** (tela inicial): números do mês, franquia de notas de cada cliente (alerta a partir
  de 80%), quem mais pediu notas e atalhos para lançar.
- **Registrar nota**: o cliente pede pelo WhatsApp, o escritório emite e envia, e depois lança
  aqui com número, data de emissão e, se quiser, o XML/PDF (os dados do XML são lidos sozinhos),
  o canal e a data do pedido (para medir o prazo de atendimento).
- **Lançar XMLs em lote**: vários XMLs de uma vez; cada um é associado ao cliente pelo CNPJ do
  emitente, com conferência antes de gravar. PDFs de mesmo nome ou número são anexados juntos.
- **Guia recalculada / Multa**: com a guia anexada, tributo, competência, motivo e causa. Sempre
  que a opção "Outro" é escolhida, um campo para descrevê-la é obrigatório.
- **Perfil do cliente**: tudo do cliente no período, com **ficha para imprimir/salvar em PDF**
  (reunião de reajuste) e o indicador **honorário por demanda**.
- **Excluir empresa**: pela lista ou pelo perfil; se houver registros, mostra o que será apagado e
  exige digitar EXCLUIR. **Administradores** também podem selecionar várias empresas (com busca e
  "selecionar todas") e excluir em lote. O primeiro usuário criado é administrador; outros são
  promovidos em *Usuários → Tornar admin*.
- **Responsável por cliente**: cada empresa tem uma pessoa da equipe; painel, notas e relatório
  filtram por responsável.

O acesso de clientes ao sistema vem **desligado** (variável `ACESSO_CLIENTES`). Ligado, os
clientes podem abrir solicitações e acompanhar o andamento, como na primeira versão.

---

Sistema web para escritórios de contabilidade receberem, acompanharem e responderem
os pedidos de emissão de notas fiscais dos seus clientes.

- **Clientes** entram no sistema, preenchem o pedido de nota (tomador, valor, descrição,
  competência), acompanham o andamento e baixam o PDF/XML quando a nota é emitida.
- **O escritório** vê todas as solicitações num painel, assume a emissão, informa o número
  da nota, anexa os arquivos, rejeita pedidos com dados faltando e conversa com o cliente.

## Como rodar

Requisito: **Node.js 22.13 ou superior**. O banco é o SQLite embutido no Node; a única
dependência externa é a `pdfjs-dist`, usada para ler PDFs na importação de empresas.

```bash
npm install
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
| `ACESSO_CLIENTES` | —                        | Use `1` para permitir login de clientes            |
| `CONFIAR_PROXY` | —                          | Use `1` atrás de proxy (Caddy) para obter o IP real |
| `BACKUP_DIR`    | `DATA_DIR/backups`         | Pasta dos backups diários                          |
| `BACKUP_HORA`   | `3`                        | Hora do backup diário (Brasília)                   |
| `BACKUP_DIAS`   | `30`                       | Dias de cópias guardadas (`0` desliga o backup)    |

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

## Importar empresas de planilha ou PDF

Em *Empresas* → **Importar planilha ou PDF**, envie a relação de clientes:

- **Planilha (.xlsx ou .csv):** as colunas são reconhecidas pelo cabeçalho, que não precisa
  estar na primeira linha: CNPJ, razão social, e-mail, telefone, plano, notas incluídas,
  honorário e "tem plano de notas". CNPJ guardado como número (sem o zero à esquerda) é
  corrigido. Há uma **planilha modelo** para baixar na própria tela.
- **PDF:** relatórios de clientes exportados por sistemas contábeis, em tabela (inclusive
  com cabeçalho repetido em cada página) ou em lista corrida. PDF escaneado (imagem) não é lido.

Antes de gravar, o sistema mostra cada linha como **nova**, **já cadastrada** ou **com erro**
(CNPJ inválido, CPF, CNPJ repetido no arquivo). Você escolhe o que importar e se quer
atualizar as empresas já cadastradas; nesse caso, só os campos preenchidos no arquivo são alterados.

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
  importacao.js leitura de planilhas e PDFs para importar empresas
public/         interface web (HTML/CSS/JS, sem build)
test/           testes automatizados (node --test)
```

## Segurança

- Senhas com `scrypt` e sal aleatório; sessões em cookie `HttpOnly` + `SameSite=Strict`.
- Requisições que alteram dados exigem `Content-Type: application/json` (proteção CSRF).
- Cabeçalhos de segurança (CSP, `X-Frame-Options`, `nosniff`); a interface monta o HTML
  sem `innerHTML`, evitando XSS.
- Arquivos anexados são salvos com nome aleatório, fora da pasta pública.

- Login bloqueado por 15 minutos após 5 senhas erradas (por conta e IP).

## Colocar no ar

Veja o passo a passo em [`docs/IMPLANTACAO.md`](docs/IMPLANTACAO.md): servidor com Docker,
HTTPS automático (Caddy), backups diários e atualização com um comando
(`deploy/instalar.sh` e `deploy/atualizar.sh`).

## Próximos passos sugeridos

- Notificação por e-mail/WhatsApp ao cliente quando a nota for emitida ou rejeitada.
- Cadastro de tomadores frequentes para preenchimento automático.
- Integração com a prefeitura / emissor de NFS-e para emissão automática.
