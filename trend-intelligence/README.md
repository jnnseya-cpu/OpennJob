# Trend Intelligence (internal engine)

An **invisible, backend-only** growth-intelligence engine embedded in this repository.
It reads demand signals, scores opportunities, and issues a versioned, approval-gated
**Growth Brief** that can retarget marketing/SEO work — all headless, with **no
user-facing UI and no user-facing routes**.

Built to the *Trend Intelligence AI* build specification (v2.3, 10 Nov 2026).

## Boundaries (non-negotiable)

- **Isolated.** This subproject is self-contained (like `career-agent/`). It is **not**
  wired into the Node app build (`apps/*`, `packages/*`), the deployed containers, or
  the candidate-facing API. The locked job-application platform and its safety core
  (`packages/core/src/policy.ts`) are untouched.
- **Invisible to users.** No UI, no user routes. It runs in the background.
- **Data boundary.** Operates on **aggregate / public / business signals** for the
  platform's own growth. It does **not** mine individual users' personal data (CVs,
  passports, applications). Using personal data would breach OpennJob's privacy rules
  and could not lawfully be "invisible" — it would require explicit consent and is out
  of scope unless separately authorised.
- **Approval-gated & reversible.** Mirrors the platform's ethos: nothing privileged
  happens without approval, an audit trail, and rollback. Deterministic by default;
  AI/inference is an optional layer on top and the engine works with the model absent.

## What's built so far

| Area | Status |
|---|---|
| Deterministic detection & scoring core (`engine/scoring.py`) | ✅ lift/z + gates, opportunity & confidence scores, single-family cap, decision gating — spec §5/§17 |
| Growth Brief v1 contract (`contracts/growth-brief.v1.schema.yaml`) + validator (`engine/brief.py`) | ✅ closed-object schema + runtime window/scope rules — spec §6/App. A |
| Source registry (`engine/sources.py`) | ✅ access-path/family/terms, stale/failed cannot action, feed gap = unknown — spec §3 |
| Observation schema + scoped idempotent store (`engine/observations.py`, `engine/store.py`) | ✅ unique source-version key, replay→duplicate, changed-hash→conflict, atomic batch, PII reject, installation isolation — spec §5/§15/§16 |
| Tests (`tests/`) | ✅ 24 tests; spec worked example (86.25 / 83.5) + conformance TI-01/02/03/04 |

Run: `cd trend-intelligence && python3 -m unittest discover -s tests`

## Build sequence (remaining, staged — spec §11/§20)

1. **Foundation** — source registry, observation schema, idempotent scoped ingest,
   installation isolation. ✅ *(in-memory reference; PostgreSQL + RLS adapter to follow)*
2. **Intelligence** — baselines, clustering, score explanations, deterministic/inference
   adapter, coverage indicators. *(next)*
3. **Agent integration** — brief SDK, one SEO + one marketing draft route, approvals,
   audit, draft-only workflow.
4. **Controlled activation** — native owned-surface renderer, approved reversible
   patches, measurement, rollback, freeze.
5. **Hardening** — the §20 clean-install release gate (no new provider keys), conformance
   matrix (§21), operations.

Each stage keeps this engine isolated and the job-application platform green.
