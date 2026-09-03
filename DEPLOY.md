# Deploying PipelineOS

PipelineOS builds to a single Node process (`dist/server.cjs`) that serves both
the static SPA and the `/api` + `/mcp` surfaces. It is designed to run on Cloud
Run, but the container is a plain `node:20-slim` image and runs anywhere that
can host a container and set environment variables.

The server honors `PORT` (default `8080` in the image) and binds `0.0.0.0` when
`NODE_ENV=production`.

## Package manager

This project standardizes on **npm** with a committed `package-lock.json`. All
dependency versions are pinned (no `^`/`~` ranges) for reproducible builds, so
use `npm ci` in CI/CD rather than `npm install`. There is intentionally no
`bun.lock` or `yarn.lock`.

## Build and run locally as a container

```bash
docker build -t pipelineos:local .
docker run --rm -p 8080:8080 \
  -e NODE_ENV=production \
  -e PERSISTENCE_BACKEND=memory \
  pipelineos:local
# open http://localhost:8080  (liveness at /health, metrics at /metrics)
```

## Deploy to Cloud Run

### 1. Build and push the image

```bash
PROJECT_ID=pipelineos-d8a4e
REGION=us-central1
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/apps/pipelineos:$(git rev-parse --short HEAD)"

gcloud builds submit --tag "$IMAGE"
```

### 2. Create a runtime service account for Firestore

Attaching a service account gives the container Application Default Credentials
(ADC) with no key file. `src/server/persistence/firestore.ts` uses ADC
automatically, so `GOOGLE_APPLICATION_CREDENTIALS` is **not** needed on Cloud
Run — never bake a key file into the image.

```bash
gcloud iam service-accounts create pipelineos-run \
  --display-name "PipelineOS Cloud Run runtime"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:pipelineos-run@$PROJECT_ID.iam.gserviceaccount.com" \
  --role roles/datastore.user
```

### 3. Store secrets in Secret Manager (not `.env`)

`.env` is only for local development and is gitignored. In production, put every
secret in Secret Manager and reference it from the service. Typical secrets: the
web OIDC client secret and the session-cookie signing secret.

```bash
printf '%s' "$OIDC_CLIENT_SECRET" | gcloud secrets create oidc-client-secret --data-file=-
printf '%s' "$SESSION_SECRET"     | gcloud secrets create session-secret     --data-file=-

gcloud secrets add-iam-policy-binding oidc-client-secret \
  --member "serviceAccount:pipelineos-run@$PROJECT_ID.iam.gserviceaccount.com" \
  --role roles/secretmanager.secretAccessor
gcloud secrets add-iam-policy-binding session-secret \
  --member "serviceAccount:pipelineos-run@$PROJECT_ID.iam.gserviceaccount.com" \
  --role roles/secretmanager.secretAccessor
```

### 4. Deploy

```bash
gcloud run deploy pipelineos \
  --image "$IMAGE" \
  --region "$REGION" \
  --service-account "pipelineos-run@$PROJECT_ID.iam.gserviceaccount.com" \
  --allow-unauthenticated \
  --set-env-vars "NODE_ENV=production,PERSISTENCE_BACKEND=firestore,FIREBASE_PROJECT_ID=$PROJECT_ID,LOG_LEVEL=info" \
  --set-secrets "OIDC_CLIENT_SECRET=oidc-client-secret:latest,SESSION_SECRET=session-secret:latest"
```

Cloud Run injects `PORT`; the process picks it up automatically. Point the
`/health` and `/ready` endpoints at the platform's liveness/readiness probes.

## Configuration reference

Non-secret runtime configuration (see `.env.example` for the full list):

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | `production` serves `dist/` and binds `0.0.0.0`. |
| `PORT` | Listen port (Cloud Run sets this; image defaults to `8080`). |
| `PERSISTENCE_BACKEND` | `firestore` \| `memory` \| unset (auto by credentials). |
| `FIREBASE_PROJECT_ID` | Firestore project (defaults to `pipelineos-d8a4e`). |
| `LOG_LEVEL` | pino log level. |
| `METRICS_ENABLED` | Set `false` to disable `/metrics`. |
| `MAINTENANCE_INTERVAL_MS` | TTL cleanup sweep interval (default 5 min). |
| `CORS_ALLOWED_ORIGINS` | Comma-separated CORS allowlist. |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | Rate limiter tuning. |

Secrets (via Secret Manager, never committed): `OIDC_CLIENT_SECRET`,
`SESSION_SECRET`, and optionally `FIREBASE_SERVICE_ACCOUNT` if you cannot use
ADC. `GITHUB_TOKEN` is optional server-only headroom for prospect search.
