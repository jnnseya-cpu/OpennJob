# Switching on Workday or SuccessFactors: the supervised test

The queue fills and submits on an employer's Workday or SAP SuccessFactors site only after that
system is switched on with two pieces of evidence (APP-9): its terms were read, and one supervised
real submission worked. The step engine was built and tested against fictional pages shaped like
these systems (`apps/extension/test/fixtures/workday-apply.html`, `sf-job.html`); this test is the
first check against the real thing.

## Before
- Read the system's terms and the employer's careers-site terms. They must allow an applicant to use
  a browser extension to fill and send their own application.
- In OpennJob: Profile complete, right-to-work record for the country, stored answers for the usual
  questions (notice period, "How did you hear about us?", "Phone device type"), standing authorisation on.

## The test (about 15 minutes, you watching)
1. Pick one real job on that system that you want to apply for anyway.
2. Open it in Chrome, sign in to (or create) your account on that employer's careers site, and accept
   its privacy statement yourself. The queue never signs in or accepts anything for you.
3. On each step, open the OpennJob extension and press **Fill**, check what it wrote, and press the
   site's own **Save and Continue**. On the last step press **Submit** yourself.
4. Note what OpennJob filled correctly and what it missed (send the notes: the code gets fixed).
5. If it worked, switch the system on (as root on the server):

   ```bash
   cd /opt/opennjob && bash deploy/enable-system.sh workday          # or successfactors
   ```

   It asks you to confirm the terms check, the date of this submission, a note, and the employer's own
   domains that run the system (for example `jobs.example.org` for a SuccessFactors site on the
   employer's own address).
6. Record the check in `docs/sources.md` / `GO-LIVE.md` with the date and your name.

## After it is on
- Each morning the queue opens the application in your browser (Chrome must be open with the
  extension signed in), presses Apply, fills each step, presses Save and Continue only when the step
  has nothing that waits for you, and submits at the end after the API's go, with the site's
  confirmation as the receipt.
- It stops, and leaves the tab open, at a sign-in page (sign in once, then **I have signed in: try
  again** in the Tracker) and at any declaration step (equality monitoring, "I consent", convictions).
  The steps before it are already saved on the employer's site: you finish only the last one.
- Switch it off at any time: `bash deploy/enable-system.sh workday off`.
