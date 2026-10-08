# Deploying the OpennJob API to Google Cloud Run

> **WRITTEN FROM MEMORY. NOT EXECUTED.** Nobody ran these commands for this repository:
> there was no Google Cloud project, no `gcloud` login and no Docker daemon where the
> code was built. The command names and flags are as remembered and may have changed.
> Check each one against `gcloud <command> --help` and the current Google Cloud
> documentation before relying on it, and expect to fix things on the first run.
>
> What this covers: the API container on Cloud Run, PostgreSQL 16 on Cloud SQL, secrets
> in Secret Manager, migrations as a Cloud Run job. What it does not cover: a custom
> domain, a load balancer or WAF, backups policy, monitoring and alerting, a staging
> environment, CI/CD to Cloud Run. Those are on the "Not done" list in `GO-LIVE.md`.

Set these once in your shell. Every value is a placeholder.

```bash
export PROJECT_ID=your-project-id
export REGION=europe-west2            # London; choose with your data-protection adviser
export REPO=opennjob
export SERVICE=opennjob-api
export SQL_INSTANCE=opennjob-pg
export DB_NAME=opennjob
export DB_USER=opennjob
export SA=opennjob-api@$PROJECT_ID.iam.gserviceaccount.com
export IMAGE=$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/api:$(git rev-parse --short HEAD)

gcloud config set project $PROJECT_ID
```

## 1. Enable the services

```bash
gcloud services enable run.googleapis.com sqladmin.googleapis.com \
  secretmanager.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com
```

## 2. Build and push the image

```bash
gcloud artifacts repositories create $REPO --repository-format=docker --location=$REGION

# Builds the repository's Dockerfile with Cloud Build and pushes the result.
gcloud builds submit --tag $IMAGE .
```

## 3. Cloud SQL (PostgreSQL 16)

```bash
gcloud sql instances create $SQL_INSTANCE \
  --database-version=POSTGRES_16 --region=$REGION \
  --tier=db-custom-1-3840 --storage-auto-increase \
  --backup-start-time=02:00 --enable-point-in-time-recovery

gcloud sql databases create $DB_NAME --instance=$SQL_INSTANCE

# Generate the database password and keep it only in a shell variable for the next step.
DB_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")
gcloud sql users create $DB_USER --instance=$SQL_INSTANCE --password="$DB_PASSWORD"

export SQL_CONNECTION=$(gcloud sql instances describe $SQL_INSTANCE --format='value(connectionName)')
echo $SQL_CONNECTION      # PROJECT:REGION:INSTANCE
```

## 4. Secret Manager

Three secrets. `OPENNJOB_DATA_KEY` encrypts CVs, passports and statements: **if it is
lost the data cannot be read**. Keep a copy under your own key-management procedure
before you store any real data. The API has no key rotation.

```bash
# The connection string, over the unix socket Cloud Run mounts at /cloudsql/...
printf 'postgres://%s:%s@/%s?host=/cloudsql/%s' "$DB_USER" "$DB_PASSWORD" "$DB_NAME" "$SQL_CONNECTION" \
  | gcloud secrets create opennjob-database-url --data-file=-
unset DB_PASSWORD

node -e "process.stdout.write(require('crypto').randomBytes(48).toString('base64url'))" \
  | gcloud secrets create opennjob-jwt-secret --data-file=-

node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" \
  | gcloud secrets create opennjob-data-key --data-file=-
```

Add `GEMINI_API_KEY` and `OPENNJOB_EMPLOYER_KEY` the same way if you use them.

## 5. A service account that can read those secrets and reach the database

```bash
gcloud iam service-accounts create opennjob-api --display-name="OpennJob API"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA" --role="roles/cloudsql.client"

for s in opennjob-database-url opennjob-jwt-secret opennjob-data-key; do
  gcloud secrets add-iam-policy-binding $s \
    --member="serviceAccount:$SA" --role="roles/secretmanager.secretAccessor"
done
```

## 6. Run the migrations (a Cloud Run job, same image)

```bash
gcloud run jobs create opennjob-migrate \
  --image=$IMAGE --region=$REGION --service-account=$SA \
  --set-cloudsql-instances=$SQL_CONNECTION \
  --set-secrets=DATABASE_URL=opennjob-database-url:latest \
  --command=node --args=apps/api/dist/migrate-cli.js \
  --max-retries=0

gcloud run jobs execute opennjob-migrate --region=$REGION --wait
```

Run it again before each deploy that adds a migration (first
`gcloud run jobs update opennjob-migrate --image=$IMAGE --region=$REGION`). It does
nothing when the database is up to date. The API refuses to start on a database that is
missing migrations, so a deploy made in the wrong order fails instead of half working.

## 7. Deploy the API

```bash
gcloud run deploy $SERVICE \
  --image=$IMAGE --region=$REGION --service-account=$SA \
  --add-cloudsql-instances=$SQL_CONNECTION \
  --set-secrets=DATABASE_URL=opennjob-database-url:latest,OPENNJOB_JWT_SECRET=opennjob-jwt-secret:latest,OPENNJOB_DATA_KEY=opennjob-data-key:latest \
  --set-env-vars=NODE_ENV=production,HOST=0.0.0.0,OPENNJOB_TRUST_PROXY=1,OPENNJOB_DEMO_JOBS=false \
  --set-env-vars=OPENNJOB_CORS_ORIGINS=chrome-extension://YOUR_EXTENSION_ID \
  --port=8080 --allow-unauthenticated \
  --min-instances=0 --max-instances=1 \
  --cpu=1 --memory=512Mi --timeout=60
```

Notes on the flags:

- `--allow-unauthenticated` makes the URL public at the network level. The API does its
  own authentication (`/auth/login`, access tokens). The extension has to reach it.
- `--max-instances=1` on purpose. The login rate limit is counted in each instance's
  memory; with more than one instance each keeps its own count. Raise it only after
  putting a shared limiter in front (see `GO-LIVE.md`).
- `OPENNJOB_TRUST_PROXY=1` makes the rate limit use the caller's address from
  `X-Forwarded-For`. Whether `1` is the right hop count for Cloud Run's front end was not
  checked: confirm it by looking at what address the API sees.
- Cloud Run sets `PORT` itself and sends `SIGTERM` before stopping an instance; the API
  finishes the requests in flight and closes its database pool.
- `OPENNJOB_CORS_ORIGINS` must list the extension's id (`chrome-extension://...`), which
  you only have once the extension is packed or published. In production any other
  extension origin is refused.

## 8. Check it

```bash
export URL=$(gcloud run services describe $SERVICE --region=$REGION --format='value(status.url)')
curl -s $URL/health            # {"status":"ok","persistence":"postgres","database":"up"}
curl -s $URL/auth/versions
gcloud run services logs read $SERVICE --region=$REGION --limit=50
```

The logs are JSON lines. They should contain request lines (method, path, status, user
id) and nothing from any CV, passport or statement. If you ever see such content in the
logs, treat it as an incident.

## 9. Later deploys

```bash
export IMAGE=$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/api:$(git rev-parse --short HEAD)
gcloud builds submit --tag $IMAGE .
gcloud run jobs update opennjob-migrate --image=$IMAGE --region=$REGION
gcloud run jobs execute opennjob-migrate --region=$REGION --wait
gcloud run deploy $SERVICE --image=$IMAGE --region=$REGION
```

## Not covered here

Custom domain and certificate, Cloud Armor or another WAF, uptime checks and alerting,
log retention, Cloud SQL backup testing (a backup you have not restored is not a backup),
private IP for Cloud SQL, a staging project, rotating any of the three secrets, and cost
controls. See `GO-LIVE.md`.
