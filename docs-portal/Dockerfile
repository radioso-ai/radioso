FROM node:24-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY docs-portal/package.json ./docs-portal/package.json
COPY packages/ui/package.json ./packages/ui/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter radioso-docs-portal...

FROM deps AS builder
COPY backend/openapi.json ./backend/openapi.json
COPY docs-portal ./docs-portal
COPY packages/ui ./packages/ui
RUN pnpm --dir docs-portal run build

FROM node:24-bookworm-slim AS runner
WORKDIR /app/docs-portal
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/docs-portal ./
COPY --from=builder /app/packages/ui ../packages/ui
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["./node_modules/.bin/next", "start", "--port", "3000"]
