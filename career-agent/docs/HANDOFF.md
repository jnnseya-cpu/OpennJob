# Handoff — NSEYA Career Agent (personal release)

What the developer handoff (section 9) asks for, and where it is.

| Deliverable | Where |
|---|---|
| Source and checksums | this repository; `docs/acceptance.json` → `source_manifest` (SHA-256 per file) |
| Locked dependencies | `requirements.lock` (tested); clean install recorded as T02 |
| Migrations | `agent/store.py` → `MIGRATIONS`, tracked in `schema_migrations`; older ledgers upgrade in place |
| Synthetic fixtures | `fixtures/` (forms, routes, synthetic boundary data), `contracts/attempt-snapshot.example.json` |
| Adapter certification evidence | none for a real employer yet; `agent.routes certify` records it in the adapter |
| Full test report | `docs/ACCEPTANCE.md`, `docs/acceptance.json` (`python3 scripts/release_gate.py`) |
| Configuration and secrets | `.env.example`; secrets only in the process environment |
| Live receipt and report evidence | not yet: T52 |
| Supported sources and routes | `python3 -m agent.cli coverage`; `data/source_registry.json` |

## Runbooks

**Revoke or pause.** `python3 -m agent.authorize revoke` (standing authorisation) or `pause` (all
submissions). Both take effect before the next click, including one already being filled, because the
worker re-reads the policy from disk after claiming and before clicking.

**An uncertain attempt.** Check the employer's portal or e-mail. Then
`python3 -m agent.review reconcile --job ID --receipt "the reference" --confirmed`, or `--not-submitted`.
It is never retried automatically.

**A quarantined route.** `python3 -m agent.routes status` shows the last error. Fix the adapter,
re-certify (`agent.routes certify --confirmed`), then `agent.routes release --route ID --confirmed`.

**An uncertain report.** Check the inbox. `python3 -m agent.cli report-reconcile --day YYYY-MM-DD --sent`
or `--not-sent` (then the next tick sends it).

**Backup and restore.** `python3 -m agent.cli backup --file PATH` (online, with a manifest of counts and
integrity). Restore with the worker stopped: `python3 -m agent.cli restore --file PATH --confirmed`.
Copy the whole data directory (documents, packs, sealed attempts, receipts) alongside the ledger.

**Budget reached.** Analysis stops for the London day; matching resumes tomorrow. Raise
`LLM_BUDGET_GBP_DAILY` only deliberately.

## Remaining issues (named)

- T52 not run: no real route, no genuine employer receipt, no real report in the inbox.
- T15 not run: no human-labelled 50-JD set.
- No live board, LLM or SMTP call was made in this build environment.
- Declarations and consent boxes are always the applicant's (owner rule); forms that contain them are
  prepared and wait for one tap. That is by design, not a defect.
- Commercial B20-B22 (tenants, billing, data lifecycle) are out of the personal release.
