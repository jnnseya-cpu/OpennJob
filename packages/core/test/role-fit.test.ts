import { describe, expect, it } from 'vitest';
import { OTHER_FIELD_MAX_SCORE, coreTitle, matchJob, roleFit, titleFieldWords } from '../src/matching';

/** A fictional construction project manager's CV (no real person). */
const CV = [
  'Example Candidate (fictional), MCIOB. Senior Project Manager, major infrastructure.',
  'Chartered Construction Manager leading multidisciplinary teams through design, procurement, construction and commissioning.',
  'Managed electrical and mechanical packages, BIM coordination and MEP interfaces on a rail programme.',
].join('\n');

describe('role fit: the job title is checked against the CV', () => {
  it('takes the post before any dash or bracket, and drops seniority and generic words', () => {
    expect(coreTitle('Senior Project Manager - Water & Environment (UK Wide)')).toBe('Senior Project Manager');
    expect(coreTitle('Audit & Compliance Lead- Construction')).toBe('Audit & Compliance Lead');
    expect(titleFieldWords('Tax Director - OMB / Private Business Clients')).toEqual(['tax']);
    expect(titleFieldWords('Staff Nurse - Acute Medical Ward')).toEqual(['nurse']);
    expect(titleFieldWords('Senior Manager - Group Reporting')).toEqual(['reporting']); // the post alone names no field
  });

  it.each([
    ['Tax Director - OMB / Private Business Clients', false],
    ['Senior Payroll Administrator', false],
    ['Finance Manager', false],
    ['Sales Performance Manager - Midlands', false],
    ['Quantity Surveyor', false],
    ['Graduate Civil Engineer', false],
    ['Senior Manager - Group Reporting', false],
    ['Senior Project Manager - Water & Environment (UK Wide)', true],
    ['Electrical Project Manager', true],
    ['Senior Project BIM Manager - MEP Building Services', true],
    ['Construction Manager', true],
    ['Project Manager Construction Consultancy', true],
  ])('%s -> fits: %s', (title, fits) => {
    expect(roleFit(title, CV).fits).toBe(fits);
  });

  it('a job in another field is capped, however many advert words the CV shares', () => {
    const teamwork = [{ label: 'Teamwork', essential: true, keywords: ['team'] }];
    const tax = matchJob({ title: 'Tax Director', criteria: teamwork, requiresRegistration: false }, CV, undefined);
    expect(tax.score).toBe(OTHER_FIELD_MAX_SCORE);
    expect(tax.role).toMatchObject({ role: 'Tax Director', fits: false, missing: ['tax'] });
    const pm = matchJob({ title: 'Senior Project Manager', criteria: teamwork, requiresRegistration: false }, CV, undefined);
    expect(pm.score).toBe(100);
    expect(pm.role?.fits).toBe(true);
  });

  it('a French title is not checked against an English CV, and a job with no title is scored as before', () => {
    const c = [{ label: 'Teamwork', essential: true, keywords: ['team'] }];
    expect(matchJob({ title: 'Directeur fiscal', language: 'fr', criteria: c, requiresRegistration: false }, CV, undefined).score).toBe(100);
    expect(matchJob({ criteria: c, requiresRegistration: false }, CV, undefined).score).toBe(100);
  });
});
