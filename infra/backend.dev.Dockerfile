FROM node:22-bookworm-slim

WORKDIR /app/backend

COPY backend/package*.json ./
COPY packages/connector-api/package.json ../packages/connector-api/
COPY packages/connector-api/*.d.ts ../packages/connector-api/
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
COPY packages/document-parser ../packages/document-parser

EXPOSE 8080

CMD ["backend-dev-entrypoint.sh"]
