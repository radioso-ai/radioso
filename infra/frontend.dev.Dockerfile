FROM node:24-bookworm-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json ./frontend/package.json
COPY packages/routine-definition/package.json ./packages/routine-definition/package.json
COPY packages/routine-document/package.json ./packages/routine-document/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/workspace-invalidation-contract/package.json ./packages/workspace-invalidation-contract/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter radioso-frontend...

COPY frontend ./frontend
COPY packages/routine-definition ./packages/routine-definition
COPY packages/routine-document ./packages/routine-document
COPY packages/ui ./packages/ui
COPY packages/workspace-invalidation-contract ./packages/workspace-invalidation-contract

COPY infra/frontend.dev.entrypoint.sh /usr/local/bin/frontend-dev-entrypoint.sh
RUN chmod +x /usr/local/bin/frontend-dev-entrypoint.sh

ENV NEXT_TELEMETRY_DISABLED=1

EXPOSE 3000

CMD ["frontend-dev-entrypoint.sh"]
