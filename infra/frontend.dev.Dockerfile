FROM node:22-bookworm-slim

WORKDIR /app

COPY frontend/package*.json ./
RUN npm ci

COPY infra/frontend.dev.entrypoint.sh /usr/local/bin/frontend-dev-entrypoint.sh
RUN chmod +x /usr/local/bin/frontend-dev-entrypoint.sh

ENV NEXT_TELEMETRY_DISABLED=1

EXPOSE 3000

CMD ["frontend-dev-entrypoint.sh"]
