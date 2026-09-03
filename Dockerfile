# syntax=docker/dockerfile:1

# ---- Build stage -----------------------------------------------------------
# Compiles the browser bundle (vite) and the server bundle (esbuild ->
# dist/server.cjs). Uses the full dependency set and the pinned lockfile for a
# reproducible build.
FROM node:20-slim AS build
WORKDIR /app

# Install dependencies against the exact lockfile first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Build the application.
COPY . .
RUN npm run build

# Drop dev dependencies so only production deps are carried into the runtime
# image. `--packages=external` in the esbuild step means dist/server.cjs still
# requires these at runtime.
RUN npm prune --omit=dev

# ---- Runtime stage ---------------------------------------------------------
# Slim, non-root image that runs the bundled server. Cloud Run sets PORT and
# expects the process to listen on 0.0.0.0 (handled in server.ts).
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# node:*-slim already provides an unprivileged `node` user.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# package.json is the single source of the app version (see src/server/version.ts)
# and is read at runtime, so it must be present at the working directory.
COPY --from=build --chown=node:node /app/package.json ./package.json

USER node

# Documented default; Cloud Run overrides via the PORT env var.
ENV PORT=8080
EXPOSE 8080

# Lightweight container healthcheck hitting the liveness endpoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.cjs"]
