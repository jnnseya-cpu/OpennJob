# Vercel (frontend only)

Vercel can host the **web app** (a static export). It cannot host the API in its current form: the
API is a long-running NestJS process with a PostgreSQL pool. Run the API on the VPS
(`deploy/hostinger-vps.md`) or Cloud Run (`deploy/gcp-cloud-run.md`) at, say,
`https://api.example.org`.

**Status: written, not executed.**

1. New Vercel project from the GitHub repository. Root directory: `apps/web`. Framework: Next.js.
   Install command: `cd ../.. && npm ci`. Build command: `npm run build`. Output: `out`.
2. Environment variable (build time): `NEXT_PUBLIC_OPENNJOB_API_BASE=https://api.example.org`.
   (`apps/web/public/opennjob-config.json` is empty by default, so this value is used.)
3. On the API, allow the Vercel origin: `OPENNJOB_CORS_ORIGINS=https://app.example.org`.
4. Add security headers in the Vercel project (the static export cannot set them itself), matching
   `deploy/Caddyfile`.

With the VPS option you need none of this: Caddy serves the web app and the API on one origin.
