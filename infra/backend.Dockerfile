FROM node:22-bookworm-slim AS deps

WORKDIR /app/backend

COPY backend/package*.json ./
COPY packages/connector-api/package.json ../packages/connector-api/
COPY packages/connector-api/*.d.ts ../packages/connector-api/
COPY packages/document-parser/package.json ../packages/document-parser/
COPY packages/document-parser/*.d.ts ../packages/document-parser/
COPY packages/document-parser/*.js ../packages/document-parser/
COPY packages/document-parser/parsers ../packages/document-parser/parsers
RUN npm ci

FROM deps AS build

COPY backend/tsconfig.json ./
COPY backend/openapi.yaml ./
COPY backend/scripts ./scripts
COPY backend/src ./src
COPY packages/connector-api ../packages/connector-api
COPY packages/document-parser ../packages/document-parser
RUN npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app/backend
ENV NODE_ENV=production

COPY backend/package*.json ./
COPY packages/connector-api/package.json ../packages/connector-api/
COPY packages/connector-api/*.d.ts ../packages/connector-api/
COPY packages/document-parser/package.json ../packages/document-parser/
COPY packages/document-parser/*.d.ts ../packages/document-parser/
COPY packages/document-parser/*.js ../packages/document-parser/
COPY packages/document-parser/parsers ../packages/document-parser/parsers
RUN npm ci --omit=dev

COPY --from=build /app/backend/dist ./dist
COPY --from=build /app/backend/openapi.yaml ./openapi.yaml

EXPOSE 8080

CMD ["npm", "run", "start:http"]
