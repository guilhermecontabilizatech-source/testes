# Imagem do sistema de notas fiscais (sem dependências externas além do Node).
FROM node:22-alpine

ENV NODE_ENV=production \
    DATA_DIR=/dados \
    PORT=3000

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Roda com o usuário "node" (uid 1000), não como root.
RUN mkdir -p /dados && chown node:node /dados
USER node
VOLUME /dados
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/saude || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
