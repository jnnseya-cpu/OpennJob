Fixture application forms for the Playwright tests.

Written from scratch for OpennJob. The employers are fictional and the markup, wording and
styling are not copied from any real recruitment site. They are "in the style of" the
kinds of form an applicant meets, nothing more. Passing these tests does
NOT show that the extension works on any real employer's website.

- nhs-style-application.html : multi-section form with supporting information and declarations
- construction-application.html : English construction-sector form with membership and CSCS numbers,
                               security-clearance, right-to-work, sponsorship and conflict-of-interest questions
- candidature-fr.html        : French application form (prénom, nom, courriel, lettre de motivation,
                               casier judiciaire, permis de travail, références, déclaration sur l'honneur)
- agency-quick-apply.html    : short form with no declarations
- captcha-application.html   : short form with a CAPTCHA-like widget (a static mock-up)
- login-wall.html            : a sign-in page
- queue-*.html               : forms for the queue tests (queue.spec.ts). Each reports a real submit to
                               the fixture server (`/hit?form=NAME`). plain: ordinary questions only, then
                               a confirmation page; noconfirm: no confirmation; unknown: a required question
                               with no stored answer; declaration: a convictions question; upload: a required CV file
- queue-thanks.html          : the confirmation page ("Thank you. Your application has been received.")
- queue-rtw.html, queue-rtw-convictions.html : right to work and sponsorship only, and the same with a convictions
  question (work-rights.spec.ts, OD-5). Fictional employer.
- queue-cv.html, queue-cv-cover.html : a required CV upload, and the same with a required cover-letter
  file (cv-upload.spec.ts). Fictional employer.
