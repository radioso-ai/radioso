FROM node:22-bookworm-slim AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci

FROM deps AS build

COPY tsconfig.json ./
COPY openapi.yaml ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/openapi.yaml ./openapi.yaml

EXPOSE 8080

CMD ["node", "dist/src/index.js"]
