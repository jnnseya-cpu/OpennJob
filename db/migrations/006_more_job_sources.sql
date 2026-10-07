-- Two more job-search APIs: ReliefWeb (UN OCHA; humanitarian and development jobs, strong in
-- countries Adzuna does not cover, such as DR Congo) and Jooble (an aggregator covering about
-- 60 countries, including the UAE). Both are off until the operator configures them.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_source_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_source_check
  CHECK (source IN ('greenhouse', 'lever', 'ashby', 'adzuna', 'reed', 'reliefweb', 'jooble', 'sample', 'employer'));
