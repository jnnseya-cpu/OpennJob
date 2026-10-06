# Candidate web app: brief

The API (`apps/api`) and the Chrome extension (`apps/extension`) exist and are tested. Candidates have no website yet. This brief describes the web app to build next.

## What to build
A Next.js 14 app in `apps/web` (App Router, TypeScript strict) that talks to the existing API. Phone-first.

## Reference prototype
`docs/prototype/opennjob-demo.html` is a clickable single-file prototype of the intended flow, using invented jobs and example CVs. Open it in a browser. Copy its flow, wording and layout; do not copy its data or its in-page matching code (the real logic lives in `packages/core` and is served by the API). Its "Write with Claude" buttons only work inside Claude and fall back to a built-in drafter elsewhere.

## Screens and the API routes behind them
Check `apps/api/src/controllers.ts` for exact shapes before coding.
1. Register and sign in: `POST /auth/register` (needs accepted terms and privacy versions from `GET /auth/versions`), `POST /auth/login`.
2. Profile: CV text, credential passport per industry pack, and preferences (languages, countries, cities; nothing selected means everything): `GET/PUT /profile`, `GET/PUT /passport`.
3. Matches: pack and region filters, score, gaps, eligibility: `GET /jobs/matches`.
4. Agent run at the apply threshold (default 80%): `POST /agent/run`.
5. Application review: requirements with evidence, editable statement, sensitive fields the user must confirm, approve: `POST /applications`, `POST /applications/:id/confirm`, `POST /applications/:id/submitted`.
6. Tracker: `GET /applications`.
7. Interview practice: `GET /interview/questions`, `POST /interview/feedback`.
8. Account: export and delete: `GET /account/export`, `DELETE /account`.

## Rules that must hold in the UI
- The user confirms every sensitive field themselves. Never pre-tick a declaration.
- Auto mode never submits a form that has sensitive fields.
- Never log CV, passport or statement content, in the browser console or anywhere else.
- Say plainly when something is simulated or unavailable.

## Not in the API yet (build or stub, and say which)
- Email verification and password reset.
- CV upload as PDF or Word (the API takes text).
- The web origin must be added to `OPENNJOB_CORS_ORIGINS`.
- Billing.

## Done means
`npm run build`, `npm test` and `npm run test:e2e` pass from the repo root, with Playwright tests covering register, profile, matches, review and approve, and account deletion against the real built API. Update `README.md`, `CLAUDE.md` and `GO-LIVE.md`.
