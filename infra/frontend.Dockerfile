FROM node:22-bookworm-slim AS ee-frontend-build

WORKDIR /app/ee

COPY ee/package*.json ./
COPY ee/packages/embed-widget/package*.json ./packages/embed-widget/
COPY ee/packages/auth-frontend/package*.json ./packages/auth-frontend/
RUN npm install --package-lock=false --no-audit --no-fund

COPY ee/packages/embed-widget ./packages/embed-widget
COPY ee/packages/auth-frontend ./packages/auth-frontend
RUN npm run build --workspace @radioso/enterprise-embed-widget
RUN npm run build --workspace @radioso/enterprise-auth-frontend

FROM node:22-bookworm-slim AS deps

WORKDIR /app/frontend
ARG RADIOSO_EDITION=oss

COPY frontend/package*.json ./
COPY --from=ee-frontend-build /app/ee/packages/embed-widget ../ee/packages/embed-widget
COPY --from=ee-frontend-build /app/ee/packages/auth-frontend ../ee/packages/auth-frontend
RUN npm ci && \
    if [ "$RADIOSO_EDITION" = "enterprise" ]; then \
      npm install --install-links=true --no-save --package-lock=false --no-audit --no-fund ../ee/packages/embed-widget ../ee/packages/auth-frontend; \
    fi

FROM node:22-bookworm-slim AS builder

WORKDIR /app
ARG BACKEND_INTERNAL_URL=http://backend:8080
ARG RADIOSO_EDITION=oss
ENV BACKEND_INTERNAL_URL=$BACKEND_INTERNAL_URL
ENV RADIOSO_EDITION=$RADIOSO_EDITION
ENV NEXT_PUBLIC_RADIOSO_EDITION=$RADIOSO_EDITION
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/frontend/node_modules ./frontend/node_modules
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

WORKDIR /app/frontend
RUN npm run build

FROM node:22-bookworm-slim AS runner

WORKDIR /app
ARG BACKEND_INTERNAL_URL=http://backend:8080
ARG RADIOSO_EDITION=oss
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV BACKEND_INTERNAL_URL=$BACKEND_INTERNAL_URL
ENV RADIOSO_EDITION=$RADIOSO_EDITION
ENV NEXT_PUBLIC_RADIOSO_EDITION=$RADIOSO_EDITION

COPY --from=builder /app/frontend ./
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["npm", "run", "start", "--", "-H", "0.0.0.0", "-p", "3000"]
