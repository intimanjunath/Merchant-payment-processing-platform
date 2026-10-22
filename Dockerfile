# Images for the API, the worker and the dashboard, built from one workspace.
# Compose picks the target: `app` (API, worker and the init job, which differ
# only in their command) or `web` (nginx serving the built dashboard).

# Keep the Node version in step with .nvmrc and compose.yaml.
FROM node:24.22.1-bookworm-slim AS base
WORKDIR /app

# Workspace manifests first, so dependency layers are reused until they change.
FROM base AS manifests
COPY package.json package-lock.json ./
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/observability/package.json packages/observability/
COPY packages/payments/package.json packages/payments/
COPY packages/provider/package.json packages/provider/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/

FROM manifests AS build
RUN npm ci
COPY tsconfig.json tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN npm run build && npm run build --workspace @payments/web

# Production dependencies of the API and worker (and the packages they use); not the dashboard's.
FROM manifests AS prod-deps
RUN npm ci --omit=dev --workspace @payments/api --workspace @payments/worker

# API, worker and init: compiled packages, their SQL, and production dependencies only.
FROM base AS app
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=manifests /app /app
COPY --from=build /app/packages/config/dist packages/config/dist
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/packages/db/migrations packages/db/migrations
COPY --from=build /app/packages/db/seeds packages/db/seeds
COPY --from=build /app/packages/observability/dist packages/observability/dist
COPY --from=build /app/packages/payments/dist packages/payments/dist
COPY --from=build /app/packages/provider/dist packages/provider/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/worker/dist apps/worker/dist
USER node
CMD ["node", "apps/api/dist/main.js"]

# The dashboard: static files, with /api proxied to the API.
FROM nginx:1.31.6-alpine AS web
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
