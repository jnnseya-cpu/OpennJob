# Launch checklist (personal trial)

1. Set up as in `README.md`; run `python3 -m agent.worker --preflight` and fix what it lists.
2. Put your confirmed details in `data/local/profile.json` and `data/local/answer_library.json`, and add
   your right to work and sponsorship status for each country you can work in, each with its supporting
   document: `python3 -m agent.rights add ... --confirmed`. Countries with no record are asked of you.
   Unknown answers stay unknown (`"confirmed": false`); the worker leaves those fields to you.
3. Seed or discover jobs. For each job you want: replace any researched summary with the full current
   advert, review every requirement, run `agent.cli prepare`, read the pack.
4. Write an adapter for the exact application page (`data/adapter.example.json`): selectors, uploads,
   the description selector, CAPTCHA and login blockers, the submit control and a receipt pattern that
   matches only real success. Mark declaration fields `"declaration": true`. Try it on
   `fixtures/application.html` first, then set `reviewed` and `route_tested`.
5. `agent.review verify-job`, then `approve-pack`. Run `agent.worker --once` (dry run) and look.
6. `agent.worker --submit` (or `agent.launch --submit`): the browser fills the form and uploads the
   documents; you answer the declarations, check everything and click submit. The receipt is recorded.
7. Send one report by hand (`agent.cli send-report`) before relying on the 09:00 schedule.
8. Check needs-input events, uncertain attempts and source failures every day. Do not lower the 80%
   threshold because the queue is short.
