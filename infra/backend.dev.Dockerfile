FROM node:24-bookworm-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# procps provides `ps`, which crawlee (used by @radioso/crawler) shells out to
# for child-process resource monitoring. Without it the crawler worker fails
# every job with `spawn ps ENOENT`.
RUN apt-get update \
  && apt-get install -y --no-install-recommends procps \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json ./backend/package.json
COPY packages/conversation-contract/package.json ./packages/conversation-contract/package.json
COPY packages/conversation-contract/*.d.ts ./packages/conversation-contract/
COPY packages/conversation-engine/package.json ./packages/conversation-engine/package.json
COPY packages/conversation-defaults/package.json ./packages/conversation-defaults/package.json
COPY packages/conversation-tools/package.json ./packages/conversation-tools/package.json
COPY packages/connector-api/package.json ./packages/connector-api/package.json
COPY packages/connector-api/*.d.ts ./packages/connector-api/
COPY packages/crawler/package.json ./packages/crawler/package.json
COPY packages/document-parser/package.json ./packages/document-parser/package.json
COPY packages/document-parser/*.d.ts ./packages/document-parser/
COPY packages/document-parser/*.js ./packages/document-parser/
COPY packages/document-parser/parsers ./packages/document-parser/parsers
COPY packages/radioso-mcp-server/package.json ./packages/radioso-mcp-server/package.json
COPY packages/skill-contract/package.json ./packages/skill-contract/package.json
COPY packages/skill-contract/*.d.ts ./packages/skill-contract/
COPY packages/usage-contract/package.json ./packages/usage-contract/package.json
COPY packages/usage-contract/*.d.ts ./packages/usage-contract/
COPY infra/backend.dev.install-state.sh /usr/local/bin/backend-dev-install-state.sh
RUN chmod +x /usr/local/bin/backend-dev-install-state.sh

# Stamp in the same layer as the install so the node_modules trees Compose seeds
# from this image are marked as installed from this lockfile, and any that drift
# later fail the entrypoint's check.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter radioso-backend... --filter @radioso/crawler... --filter @radioso/mcp-server... --filter @radioso/conversation-engine... --filter @radioso/conversation-defaults... --filter @radioso/conversation-tools... \
  && backend-dev-install-state.sh write

COPY infra/backend.dev.entrypoint.sh /usr/local/bin/backend-dev-entrypoint.sh
RUN chmod +x /usr/local/bin/backend-dev-entrypoint.sh

COPY backend/tsconfig.json ./backend/tsconfig.json
COPY backend/openapi.yaml ./backend/openapi.yaml
COPY backend/prompts ./backend/prompts
COPY backend/scripts ./backend/scripts
COPY backend/src ./backend/src
COPY packages/conversation-contract ./packages/conversation-contract
COPY packages/conversation-engine ./packages/conversation-engine
COPY packages/conversation-defaults ./packages/conversation-defaults
COPY packages/conversation-tools ./packages/conversation-tools
COPY packages/connector-api ./packages/connector-api
COPY packages/crawler ./packages/crawler
COPY packages/document-parser ./packages/document-parser
COPY packages/radioso-mcp-server ./packages/radioso-mcp-server
COPY packages/skill-contract ./packages/skill-contract
COPY packages/usage-contract ./packages/usage-contract

EXPOSE 8080

CMD ["backend-dev-entrypoint.sh"]
