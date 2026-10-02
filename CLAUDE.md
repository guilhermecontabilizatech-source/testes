# CLAUDE.md

Sistema interno da ContabilizaTech (escritório de contabilidade). O usuário vai reformular boa
parte da ideia: antes de mudanças grandes, **resuma o plano e espere aprovação**. Responda em
português. Prefira mecanismos simples e de baixo custo.

A versão "controle de demandas out–dez/2026" está preservada na tag `v1-controle-demandas`.

## Stack

- Node.js ≥ 22.13, sem framework: `node:http`, `node:sqlite` (DatabaseSync). Única dependência:
  `pdfjs-dist` (importação de empresas por PDF).
- Front-end em JS puro, sem build (`public/`), rotas por hash, DOM montado com o helper `h()`
  (nunca `innerHTML`). CSP `default-src 'self'`.
- Testes: `npm test` (node --test, pasta `test/`). Rodar antes de cada commit.

## Mapa do código (o que é reaproveitável)

| Arquivo | Conteúdo |
|---|---|
| `src/app.js` | `criarApp()`: roteador (`rota(metodo, padrao, handler, {publica, papel, admin, portal, bruto})`), login com limite de tentativas, usuários e administradores, empresas (CRUD, exclusão e exclusão em lote), notas registradas, anexos |
| `src/db.js` | Esquema SQLite; colunas novas via `COLUNAS_NOVAS` (migração automática ao abrir) |
| `src/auth.js` | Senhas scrypt, sessões em cookie HttpOnly/SameSite=Strict |
| `src/validacao.js` | CNPJ/CPF, valores em reais, datas, `ErroValidacao` |
| `src/importacao.js` | Leitura de XLSX/CSV/PDF para importar empresas, com prévia |
| `src/xmlNota.js` | Leitura de XML de NF-e, NFS-e Nacional e ABRASF |
| `src/arquivos.js` | Validação e gravação de anexos (nome aleatório, fora de `public/`) |
| `src/operacional.js` | Guias recalculadas, multas e relatório por cliente (específico da v1) |
| `src/painel.js` | Indicadores do dashboard (`GET /api/painel?mes=`): clientes, honorários base, notas, guias/multas, Zen, pendências |
| `src/zen.js` | Webhook do Questor Zen (`ZEN_WEBHOOK_TOKEN`) e portal do cliente (`PORTAL_CLIENTES=1`) |
| `src/backup.js`, `scripts/` | Backup diário, redefinição de senha |
| `public/app.js`, `styles.css` | Telas; menu lateral por seções (`itensDoMenu`), gráficos em SVG (`svg()`, `graficoColunas`); identidade visual (tokens de cor no topo do CSS) |
| `deploy/`, `docs/IMPLANTACAO.md` | Docker + Caddy (HTTPS) na VPS Hostinger, `painel.contabilizatech.com.br` |

## Reformulação (portal de gestão, em fases)

Base: o protótipo Next.js "portal-contabil", refeito nesta stack. Fase 1 (feita): clientes com regime
(`REGIMES`), CPF de autônomo, endereço, contrato e observações; menu lateral; dashboard em `#/`
(o antigo painel do mês está em `#/painel-notas`). Próximas: 2) demandas e vencimentos;
3) honorários e receita; 4) multas com status e pesquisas NPS/CSAT. As notas fiscais continuam.

## Convenções

- Regras de negócio e mensagens de erro em português; código com nomes em português.
- Toda alteração de dados exige `Content-Type: application/json` (proteção CSRF), exceto rotas `bruto`.
- Opção "Outro" em qualquer select sempre abre campo de descrição obrigatório (`comOutro`).
- Identidade visual: rosa #FA146E, azul #192BC2, preto #161616, roxo #9026F0, azul claro #1188FE;
  fontes Comfortaa (títulos) e Inter (texto), em `public/fontes`.
- Acesso de clientes desligado por padrão (`ACESSO_CLIENTES`); só o portal de documentos com `PORTAL_CLIENTES=1`.
