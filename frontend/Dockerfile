FROM node:24-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json ./frontend/package.json
COPY packages/ui/package.json ./packages/ui/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter radioso-frontend...

FROM deps AS builder
ARG BACKEND_INTERNAL_URL=http://backend:8080
ENV BACKEND_INTERNAL_URL=$BACKEND_INTERNAL_URL
ENV NEXT_TELEMETRY_DISABLED=1
COPY frontend ./frontend
COPY packages/ui ./packages/ui
RUN pnpm --dir frontend run build

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ARG BACKEND_INTERNAL_URL=http://backend:8080
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV BACKEND_INTERNAL_URL=$BACKEND_INTERNAL_URL
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/frontend ./frontend
COPY --from=builder /app/packages/ui ./packages/ui
RUN chown -R node:node /app
USER node
WORKDIR /app/frontend
EXPOSE 3000
CMD ["./node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
