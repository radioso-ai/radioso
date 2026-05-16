FROM node:24-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

FROM base AS ee-backend-build

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY ee/package.json ./ee/package.json
COPY ee/packages/backend-module/package.json ./ee/packages/backend-module/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @radioso/enterprise-backend-module...

COPY ee/packages/backend-module ./ee/packages/backend-module
RUN pnpm --filter @radioso/enterprise-backend-module run build

FROM base AS deps

WORKDIR /app
ARG RADIOSO_EDITION=oss

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json ./backend/package.json
COPY packages/connector-api/package.json ./packages/connector-api/package.json
COPY packages/connector-api/*.d.ts ./packages/connector-api/
COPY packages/crawler/package.json ./packages/crawler/package.json
COPY packages/document-parser/package.json ./packages/document-parser/package.json
COPY packages/document-parser/*.d.ts ./packages/document-parser/
COPY packages/document-parser/*.js ./packages/document-parser/
COPY packages/document-parser/parsers ./packages/document-parser/parsers
COPY packages/radioso-mcp-server/package.json ./packages/radioso-mcp-server/package.json
COPY --from=ee-backend-build /app/ee/packages/backend-module ./ee/packages/backend-module
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter radioso-backend... --filter @radioso/crawler... --filter @radioso/mcp-server...
RUN if [ "$RADIOSO_EDITION" = "enterprise" ]; then \
      mkdir -p ./backend/node_modules/@radioso && \
      ln -s ../../../ee/packages/backend-module ./backend/node_modules/@radioso/enterprise-backend-module; \
    fi

FROM deps AS build

COPY backend/tsconfig.json ./backend/tsconfig.json
COPY backend/openapi.json ./backend/openapi.json
COPY backend/openapi.yaml ./backend/openapi.yaml
COPY backend/prompts ./backend/prompts
COPY backend/scripts ./backend/scripts
COPY backend/src ./backend/src
COPY packages/connector-api ./packages/connector-api
COPY packages/crawler ./packages/crawler
COPY packages/document-parser ./packages/document-parser
COPY packages/radioso-mcp-server ./packages/radioso-mcp-server
RUN pnpm --dir backend run build

FROM base AS runtime

# procps provides `ps`, which crawlee (used by @radioso/crawler) shells out to
# for child-process resource monitoring. Without it the crawler worker fails
# every job with `spawn ps ENOENT`.
RUN apt-get update \
  && apt-get install -y --no-install-recommends procps \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
ARG RADIOSO_EDITION=oss

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json ./backend/package.json
COPY packages/connector-api/package.json ./packages/connector-api/package.json
COPY packages/connector-api/*.d.ts ./packages/connector-api/
COPY packages/crawler/package.json ./packages/crawler/package.json
COPY packages/document-parser/package.json ./packages/document-parser/package.json
COPY packages/document-parser/*.d.ts ./packages/document-parser/
COPY packages/document-parser/*.js ./packages/document-parser/
COPY packages/document-parser/parsers ./packages/document-parser/parsers
COPY packages/radioso-mcp-server/package.json ./packages/radioso-mcp-server/package.json
COPY --from=ee-backend-build /app/ee/packages/backend-module ./ee/packages/backend-module
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile --filter radioso-backend... --filter @radioso/crawler... --filter @radioso/mcp-server...
RUN if [ "$RADIOSO_EDITION" = "enterprise" ]; then \
      mkdir -p ./backend/node_modules/@radioso && \
      ln -s ../../../ee/packages/backend-module ./backend/node_modules/@radioso/enterprise-backend-module; \
    fi

COPY --chown=node:node --from=build /app/backend/dist ./backend/dist
COPY --chown=node:node --from=build /app/packages/crawler/dist ./packages/crawler/dist
COPY --chown=node:node --from=build /app/packages/radioso-mcp-server/dist ./packages/radioso-mcp-server/dist
COPY --chown=node:node --from=build /app/backend/openapi.yaml ./backend/openapi.yaml
COPY --chown=node:node --from=build /app/backend/prompts ./backend/prompts

RUN mkdir -p /app/.context/document-storage && chown -R node:node /app/.context
USER node

WORKDIR /app/backend
EXPOSE 8080

CMD ["node", "./dist/src/httpServer.js"]
