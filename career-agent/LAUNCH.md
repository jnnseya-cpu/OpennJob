# Launch checklist (personal trial)

1. Install from the lock and run `scripts/verify.sh`. Run `python3 -m agent.worker --preflight` and fix
   everything it lists (it exits 1 until the browser, LLM key and budget, SMTP, a certified route and a
   confirmed profile are in place).
2. Put your confirmed details in `data/local/profile.json` and `data/local/answer_library.json`. Add right
   to work and sponsorship for each country, each with its document (`agent.rights add ... --confirmed`).
   Unknown answers stay `"confirmed": false`: forms that need them wait for you.
3. Confirm the search profiles you mean (`"confirmed": true` in `data/local/search_profiles.json`).
4. Discover, then review each extraction once (`agent.review review-matching`). This is a quality check
   for the first trial, not a permission to submit.
5. Write an adapter for one relevant employer form (`data/adapter.example.json`). Mark every declaration
   field `"declaration": true`. Record its schema (`agent.routes schema`) and certify it
   (`agent.routes certify --confirmed`).
6. Run `agent.worker --submit` without standing authorisation and submit that first application yourself.
   The receipt is captured. That is the supervised submission: `agent.routes certify --auto --job ID`.
7. Only now, if you want it: `agent.authorize grant --confirmed`. Revoke with `agent.authorize revoke`;
   it stops the next click, even one already being filled.
8. Send one report by hand (`agent.cli send-report`) and check it arrived before relying on 09:00.
9. Start `agent.launch --submit`. Each day: reconcile uncertain attempts, answer needs-input questions,
   record outcomes with `agent.outcomes add`. Never lower the 80% floor to fill the queue.
10. Back up daily: `agent.cli backup --file PATH` (and the data directory with it).
