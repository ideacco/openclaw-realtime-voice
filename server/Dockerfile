FROM node:20-alpine

WORKDIR /app/server

COPY server/package*.json ./
RUN npm ci

COPY server/ ./
RUN npm run build && npm prune --omit=dev

COPY client /app/client

EXPOSE 8080

CMD ["node", "dist/server.js"]
