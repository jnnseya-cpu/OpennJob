Adapters describe one exact application page each. Your own adapters belong in `data/local/adapters/`
(git-ignored), one JSON per exact application URL; this folder only holds this note.

No live employer adapter is pre-approved. Start from `data/adapter.example.json`.
`fixtures/application.adapter.json` is LOCAL TEST ONLY. Routes must specify the complete
job-description selector and a job-specific success pattern, and mark every declaration field with
`"declaration": true` (checkboxes and radios are always left to you). Set `reviewed` and `route_tested`
only after trying the route. Unsupported forms are recorded as needs input; a relevance score never
fabricates missing fields. The worker never presses submit: you do.
