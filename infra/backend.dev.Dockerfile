FROM node:22-bookworm-slim

WORKDIR /app/backend

COPY backend/package*.json ./
COPY packages/connector-api/package.json ../packages/connector-api/
COPY packages/connector-api/*.d.ts ../packages/connector-api/
RUN npm ci

COPY backend/tsconfig.json ./
COPY backend/openapi.yaml ./
COPY backend/scripts ./scripts
COPY backend/src ./src
COPY packages/connector-api ../packages/connector-api

EXPOSE 8080

CMD ["npm", "run", "dev"]
