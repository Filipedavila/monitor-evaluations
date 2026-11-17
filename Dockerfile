ARG NODE_IMAGE=node:22-alpine
# Deve usar a mesma versão do Alpine em que NODE_IMAGE é baseada (musl compatível).
ARG RUNTIME_IMAGE=alpine:3.22

# Obrigatório: "local" (instala Chromium) ou "remote" (usa browser CDP externo).
# Sem valor padrão de propósito: o build falha se não for informado ou se for inválido.
ARG BROWSER_MODE

FROM ${NODE_IMAGE} AS node-base

FROM node-base AS deps
WORKDIR /app

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

COPY package.json package-lock.json ./
COPY tsconfig.json tsconfig.build.json ./
COPY qualweb-playwright-driver-1.0.0.tgz qualweb-core-0.9.1.tgz ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts
# TEMP add qualweb tar
FROM deps AS build
COPY tsconfig.json  tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node-base AS prod-deps
WORKDIR /app

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
COPY qualweb-playwright-driver-1.0.0.tgz qualweb-core-0.9.1.tgz ./
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts

# ---------------------------------------------------------------------------
# Development
# ---------------------------------------------------------------------------
FROM deps AS development-local
ENV NODE_ENV=development \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# nss, freetype e harfbuzz já vêm como dependências do chromium.
RUN apk add --no-cache \
      chromium \
      ttf-freefont

FROM deps AS development-remote
ENV NODE_ENV=development

FROM development-${BROWSER_MODE:-remote} AS development
ARG BROWSER_MODE
RUN [ "$BROWSER_MODE" = local ] || [ "$BROWSER_MODE" = remote ]
WORKDIR /app

COPY . .
CMD ["npm", "run", "start:dev"]

# ---------------------------------------------------------------------------
# Production
# ---------------------------------------------------------------------------
# Minimal Runtime Alpine
FROM ${RUNTIME_IMAGE} AS runtime-base

RUN apk add --no-cache libstdc++ tini \
    && addgroup -g 1000 node \
    && adduser -u 1000 -G node -s /bin/sh -D node

COPY --from=node-base /usr/local/bin/node /usr/local/bin/node

FROM runtime-base AS production-base-local
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

RUN apk add --no-cache \
      chromium \
      ttf-freefont

FROM runtime-base AS production-base-remote

FROM production-base-${BROWSER_MODE:-remote} AS production
ARG BROWSER_MODE
RUN [ "$BROWSER_MODE" = local ] || [ "$BROWSER_MODE" = remote ]
WORKDIR /app

ENV NODE_ENV=production

RUN mkdir -p storage/evaluations \
    && chown -R node:node /app

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/worker.js"]
