-- Three more kinds of job: 'link' (a job the person found and pasted, with its application page
-- and advert text), and 'workday' and 'successfactors' (found on an employer's own careers site,
-- listed by the operator after its terms were checked). Each comes with the employer's own
-- application page, so the queue can apply there.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_source_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_source_check
  CHECK (source IN ('greenhouse', 'lever', 'ashby', 'adzuna', 'reed', 'reliefweb', 'jooble', 'sample', 'employer', 'link', 'workday', 'successfactors'));
