FROM node:24-bookworm-slim AS ee-backend-build

WORKDIR /app/ee

COPY ee/package*.json ./
COPY ee/packages/backend-module/package*.json ./packages/backend-module/
RUN npm install --package-lock=false --no-audit --no-fund

COPY ee/packages/backend-module ./packages/backend-module
RUN npm run build --workspace @radioso/enterprise-backend-module

FROM node:24-bookworm-slim AS deps

WORKDIR /app/backend
ARG RADIOSO_EDITION=oss

COPY backend/package*.json ./
COPY packages/connector-api/package.json ../packages/connector-api/
COPY packages/connector-api/*.d.ts ../packages/connector-api/
COPY packages/crawler/package.json ../packages/crawler/
COPY packages/crawler/package-lock.json ../packages/crawler/
COPY packages/document-parser/package.json ../packages/document-parser/
COPY packages/document-parser/*.d.ts ../packages/document-parser/
COPY packages/document-parser/*.js ../packages/document-parser/
COPY packages/document-parser/parsers ../packages/document-parser/parsers
COPY --from=ee-backend-build /app/ee/packages/backend-module ../ee/packages/backend-module
RUN npm ci && \
    npm --prefix ../packages/crawler ci && \
    if [ "$RADIOSO_EDITION" = "enterprise" ]; then \
      npm install --install-links=true --no-save --package-lock=false --no-audit --no-fund ../ee/packages/backend-module; \
    fi

FROM deps AS build

COPY backend/tsconfig.json ./
COPY backend/openapi.yaml ./
COPY backend/prompts ./prompts
COPY backend/scripts ./scripts
COPY backend/src ./src
COPY packages/connector-api ../packages/connector-api
COPY packages/crawler ../packages/crawler
COPY packages/document-parser ../packages/document-parser
RUN rm -rf node_modules/@radioso/crawler && \
    mkdir -p node_modules/@radioso && \
    ln -s ../../../packages/crawler node_modules/@radioso/crawler
RUN npm run install:crawler
RUN npm run build

FROM node:24-bookworm-slim AS runtime

# procps provides `ps`, which crawlee (used by @radioso/crawler) shells out to
# for child-process resource monitoring. Without it the crawler worker fails
# every job with `spawn ps ENOENT`.
RUN apt-get update \
  && apt-get install -y --no-install-recommends procps \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend
ENV NODE_ENV=production
ARG RADIOSO_EDITION=oss

COPY backend/package*.json ./
COPY packages/connector-api/package.json ../packages/connector-api/
COPY packages/connector-api/*.d.ts ../packages/connector-api/
COPY packages/crawler/package.json ../packages/crawler/
COPY packages/crawler/package-lock.json ../packages/crawler/
COPY packages/document-parser/package.json ../packages/document-parser/
COPY packages/document-parser/*.d.ts ../packages/document-parser/
COPY packages/document-parser/*.js ../packages/document-parser/
COPY packages/document-parser/parsers ../packages/document-parser/parsers
COPY --from=ee-backend-build /app/ee/packages/backend-module ../ee/packages/backend-module
RUN npm ci --omit=dev && \
    npm --prefix ../packages/crawler ci --omit=dev && \
    if [ "$RADIOSO_EDITION" = "enterprise" ]; then \
      npm install --install-links=true --omit=dev --no-save --package-lock=false --no-audit --no-fund ../ee/packages/backend-module; \
    fi

COPY --chown=node:node --from=build /app/backend/dist ./dist
COPY --chown=node:node --from=build /app/packages/crawler/dist ../packages/crawler/dist
COPY --chown=node:node --from=build /app/backend/openapi.yaml ./openapi.yaml
COPY --chown=node:node --from=build /app/backend/prompts ./prompts

RUN rm -rf node_modules/@radioso/crawler && \
    mkdir -p node_modules/@radioso && \
    ln -s ../../../packages/crawler node_modules/@radioso/crawler

RUN mkdir -p /app/.context/document-storage && chown -R node:node /app/.context
USER node

EXPOSE 8080

CMD ["npm", "run", "start:http"]
