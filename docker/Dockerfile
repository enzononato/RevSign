###########################
#     BASE CONTAINER      #
###########################
FROM node:24-alpine3.23 AS base

RUN apk add --no-cache openssl
RUN apk add --no-cache font-freefont


###########################
#    BUILDER CONTAINER    #
###########################
FROM base AS builder

# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat
RUN apk add --no-cache jq
WORKDIR /app

COPY . .

# Install the exact turbo version resolved in the lockfile, without installing
# the rest of the dependency tree (prune must run before any npm ci).
RUN TURBO_VERSION="$(jq -r '.packages["node_modules/turbo"].version' package-lock.json)" \
    && npm install -g "turbo@${TURBO_VERSION}"

# Outputs to the /out folder
# source: https://turbo.build/repo/docs/reference/command-line-reference/prune#--docker
RUN turbo prune --scope=@documenso/remix --docker

###########################
#   INSTALLER CONTAINER   #
###########################
FROM base AS installer

# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat
RUN apk add --no-cache jq
# Required for node_modules/aws-crt
RUN apk add --no-cache make cmake g++ openssl bash

WORKDIR /app

# Disable husky from installing hooks
ENV HUSKY=0
ENV DOCKER_OUTPUT=1
ENV NEXT_TELEMETRY_DISABLED=1

# Encryption keys
ARG NEXT_PRIVATE_ENCRYPTION_KEY="CAFEBABE"
ENV NEXT_PRIVATE_ENCRYPTION_KEY="$NEXT_PRIVATE_ENCRYPTION_KEY"

ARG NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY="DEADBEEF"
ENV NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY="$NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY"

# Sub-path the app is served under (e.g. "/ESign"). Empty = root.
# Baked into the client bundle by Vite/React Router at build time; also
# required at runtime for SSR so window.__ENV__ exposes it to the client.
ARG NEXT_PUBLIC_BASE_PATH=""
ENV NEXT_PUBLIC_BASE_PATH="$NEXT_PUBLIC_BASE_PATH"

# Telemetry credentials (optional, baked into image at build time)
ARG NEXT_PRIVATE_TELEMETRY_KEY=""
ENV NEXT_PRIVATE_TELEMETRY_KEY="$NEXT_PRIVATE_TELEMETRY_KEY"

ARG NEXT_PRIVATE_TELEMETRY_HOST=""
ENV NEXT_PRIVATE_TELEMETRY_HOST="$NEXT_PRIVATE_TELEMETRY_HOST"


# Uncomment and use build args to enable remote caching
# ARG TURBO_TEAM
# ENV TURBO_TEAM=$TURBO_TEAM
# ARG TURBO_TOKEN
# ENV TURBO_TOKEN=$TURBO_TOKEN

# First install the dependencies (as they change less often)
COPY .gitignore .gitignore
COPY --from=builder /app/out/json/ .
COPY --from=builder /app/out/package-lock.json ./package-lock.json

COPY --from=builder /app/lingui.config.ts ./lingui.config.ts
COPY --from=builder /app/patches ./patches

RUN npm ci

# Then copy all the source code (as it changes more often)
COPY --from=builder /app/out/full/ .
# REVALLE: o build.sh do remix roda o overlay pt-BR e o validador (fora do turbo prune). Depois do `npm ci`,
# para que mudar esses scripts não invalide o cache da instalação.
COPY --from=builder /app/scripts/revalle/i18n ./scripts/revalle/i18n
# Finally copy the turbo.json file so that we can run turbo commands
COPY turbo.json turbo.json

ENV NODE_OPTIONS="--max-old-space-size=8192"

RUN npx turbo run build --filter=@documenso/remix...

# REVALLE: base de geolocalização por IP (DB-IP Lite City, CC BY 4.0), offline em runtime.
# Tenta o mês do build e o anterior; se o download falhar, deixa um marcador vazio e o build segue
# (o app funciona sem a base: ipLocation fica nulo).
FROM alpine:3.22 AS geoip
ARG DBIP_MONTH=""
RUN mkdir -p /geoip && \
    month="${DBIP_MONTH:-$(date -u +%Y-%m)}" && \
    prev="$(date -u -d "@$(( $(date -u -d "${month}-01" +%s 2>/dev/null || echo 0) - 86400 ))" +%Y-%m 2>/dev/null || true)" && \
    ok=0 && \
    for m in "$month" "$prev"; do \
      [ -n "$m" ] || continue; \
      if wget -q -T 120 -O /tmp/dbip.mmdb.gz "https://download.db-ip.com/free/dbip-city-lite-${m}.mmdb.gz" \
        && gunzip -c /tmp/dbip.mmdb.gz > /geoip/dbip-city-lite.mmdb && [ -s /geoip/dbip-city-lite.mmdb ]; then ok=1; break; fi; \
    done; \
    if [ "$ok" != 1 ]; then echo "AVISO: base DB-IP indisponivel, seguindo sem geolocalizacao"; : > /geoip/dbip-city-lite.mmdb; fi; \
    rm -f /tmp/dbip.mmdb.gz

###########################
#     RUNNER CONTAINER    #
###########################
FROM base AS runner

ENV HUSKY=0
ENV DOCKER_OUTPUT=1

# Telemetry credentials (baked into image at build time, can be disabled at runtime)
ARG NEXT_PRIVATE_TELEMETRY_KEY=""
ENV NEXT_PRIVATE_TELEMETRY_KEY="$NEXT_PRIVATE_TELEMETRY_KEY"

ARG NEXT_PRIVATE_TELEMETRY_HOST=""
ENV NEXT_PRIVATE_TELEMETRY_HOST="$NEXT_PRIVATE_TELEMETRY_HOST"

# Don't run production as root
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nodejs

USER nodejs

WORKDIR /app

COPY --from=builder --chown=nodejs:nodejs /app/out/json/ .
# Copy the tailwind config files across
COPY --from=builder --chown=nodejs:nodejs /app/out/full/packages/tailwind-config ./packages/tailwind-config
# Copy the patches across
COPY --from=builder --chown=nodejs:nodejs /app/patches ./patches

RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Strip build-time residue that ships as production dependencies but is never
# executed at runtime.
RUN rm -rf \
    node_modules/react-email/dist/cli \
    node_modules/esbuild \
    node_modules/@esbuild \
    node_modules/.bin/esbuild \
    node_modules/.bin/email

# Automatically leverage output traces to reduce image size
# https://nodejs.org/docs/advanced-features/output-file-tracing
COPY --from=installer --chown=nodejs:nodejs /app/apps/remix/build ./apps/remix/build
COPY --from=installer --chown=nodejs:nodejs /app/apps/remix/public ./apps/remix/public

# Copy the prisma binary, schema and migrations
COPY --from=installer --chown=nodejs:nodejs /app/packages/prisma/schema.prisma ./packages/prisma/schema.prisma
COPY --from=installer --chown=nodejs:nodejs /app/packages/prisma/migrations ./packages/prisma/migrations

# REVALLE: base GeoIP offline (ver estágio geoip)
COPY --from=geoip --chown=nodejs:nodejs /geoip /app/geoip

# Generate the prisma client again, this time only targeting the client generator
RUN npx prisma generate --schema ./packages/prisma/schema.prisma --generator client \
    && npm cache clean --force


# Get the start script from docker/
COPY --chown=nodejs:nodejs ./docker/start.sh /app/apps/remix/start.sh

WORKDIR /app/apps/remix

CMD ["sh", "start.sh"]
