FROM node:22-bookworm-slim

# procps provides `ps`, which crawlee (used by @radioso/crawler) shells out to
# for child-process resource monitoring. Without it the crawler worker fails
# every job with `spawn ps ENOENT`.
RUN apt-get update \
  && apt-get install -y --no-install-recommends procps \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend

COPY backend/package*.json ./
COPY packages/connector-api/package.json ../packages/connector-api/
COPY packages/connector-api/*.d.ts ../packages/connector-api/
COPY packages/crawler/package.json ../packages/crawler/
COPY packages/crawler/package-lock.json ../packages/crawler/
COPY packages/document-parser/package.json ../packages/document-parser/
COPY packages/document-parser/*.d.ts ../packages/document-parser/
COPY packages/document-parser/*.js ../packages/document-parser/
COPY packages/document-parser/parsers ../packages/document-parser/parsers
RUN npm ci

COPY infra/backend.dev.entrypoint.sh /usr/local/bin/backend-dev-entrypoint.sh
RUN chmod +x /usr/local/bin/backend-dev-entrypoint.sh

COPY backend/tsconfig.json ./
COPY backend/openapi.yaml ./
COPY backend/prompts ./prompts
COPY backend/scripts ./scripts
COPY backend/src ./src
COPY packages/connector-api ../packages/connector-api
COPY packages/crawler ../packages/crawler
COPY packages/document-parser ../packages/document-parser

EXPOSE 8080

CMD ["backend-dev-entrypoint.sh"]
