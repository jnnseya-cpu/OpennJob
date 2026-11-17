Local route fixtures for the career-agent browser tests. LOCAL TEST ONLY: written from scratch, no
real employer, served over HTTPS on 127.0.0.1 by tests/fixture_server.py, which records each POST
(fields and file hashes) and answers with a receipt page.

plain / changed (an extra required question after certification) / jd + apply-only (description
on its own page) / jd-changed / jd-closed / multistep / frame-host (the form inside an iframe) /
demographics (a pre-selected equality answer and a pre-ticked consent box) / unknown (required
questions with no confirmed answer) / already-received (a success message before any click).
