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
