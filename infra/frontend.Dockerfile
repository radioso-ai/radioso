FROM node:24-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

FROM base AS ee-frontend-build

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY ee/package.json ./ee/package.json
COPY ee/packages/embed-widget/package.json ./ee/packages/embed-widget/package.json
COPY ee/packages/auth-frontend/package.json ./ee/packages/auth-frontend/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile \
      --filter @radioso/enterprise-embed-widget... \
      --filter @radioso/enterprise-auth-frontend...

COPY ee/packages/embed-widget ./ee/packages/embed-widget
COPY ee/packages/auth-frontend ./ee/packages/auth-frontend
RUN pnpm --filter @radioso/enterprise-embed-widget run build
RUN pnpm --filter @radioso/enterprise-auth-frontend run build

FROM base AS deps

WORKDIR /app
ARG RADIOSO_EDITION=oss

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json ./frontend/package.json
COPY --from=ee-frontend-build /app/ee/packages/embed-widget ./ee/packages/embed-widget
COPY --from=ee-frontend-build /app/ee/packages/auth-frontend ./ee/packages/auth-frontend
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile \
      --filter radioso-frontend... \
      --filter @radioso/enterprise-embed-widget... \
      --filter @radioso/enterprise-auth-frontend...
RUN if [ "$RADIOSO_EDITION" = "enterprise" ]; then \
      mkdir -p ./frontend/node_modules/@radioso && \
      ln -s ../../../ee/packages/embed-widget ./frontend/node_modules/@radioso/enterprise-embed-widget && \
      ln -s ../../../ee/packages/auth-frontend ./frontend/node_modules/@radioso/enterprise-auth-frontend; \
    fi

FROM deps AS builder

ARG BACKEND_INTERNAL_URL=http://backend:8080
ARG RADIOSO_EDITION=oss
ENV BACKEND_INTERNAL_URL=$BACKEND_INTERNAL_URL
ENV RADIOSO_EDITION=$RADIOSO_EDITION
ENV NEXT_PUBLIC_RADIOSO_EDITION=$RADIOSO_EDITION
ENV NEXT_TELEMETRY_DISABLED=1

COPY frontend ./frontend
COPY scripts/sync-ee-frontend-routes.mjs ./scripts/sync-ee-frontend-routes.mjs
COPY scripts/enterprise-feature-manifests.mjs ./scripts/enterprise-feature-manifests.mjs
COPY --from=ee-frontend-build /app/ee/packages/embed-widget/feature-manifest.mjs ./ee/packages/embed-widget/feature-manifest.mjs
COPY --from=ee-frontend-build /app/ee/packages/auth-frontend/feature-manifest.mjs ./ee/packages/auth-frontend/feature-manifest.mjs
COPY --from=ee-frontend-build /app/ee/packages/embed-widget/package.json ./ee/packages/embed-widget/package.json
COPY --from=ee-frontend-build /app/ee/packages/auth-frontend/package.json ./ee/packages/auth-frontend/package.json
COPY ee/readme.md ./ee/readme.md
COPY docs-portal/content/quickstarts/website-embed.mdx ./docs-portal/content/quickstarts/website-embed.mdx

RUN if [ "$RADIOSO_EDITION" = "enterprise" ]; then \
      node scripts/sync-ee-frontend-routes.mjs enable; \
    fi

RUN pnpm --dir frontend run build

FROM node:24-bookworm-slim AS runner

WORKDIR /app
ARG BACKEND_INTERNAL_URL=http://backend:8080
ARG RADIOSO_EDITION=oss
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV BACKEND_INTERNAL_URL=$BACKEND_INTERNAL_URL
ENV RADIOSO_EDITION=$RADIOSO_EDITION
ENV NEXT_PUBLIC_RADIOSO_EDITION=$RADIOSO_EDITION

COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/ee ./ee
COPY --chown=node:node --from=builder /app/frontend ./frontend
USER node
WORKDIR /app/frontend
EXPOSE 3000
CMD ["./node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
