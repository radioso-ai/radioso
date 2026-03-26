FROM node:22-alpine

WORKDIR /app

COPY frontend/package*.json ./
RUN npm ci

ENV NEXT_TELEMETRY_DISABLED=1

EXPOSE 3000

CMD ["npx", "next", "dev", "-H", "0.0.0.0", "-p", "3000"]
