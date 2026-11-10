import { describe, expect, it } from 'vitest';
import { APPLICATION_SYSTEMS, applicationSystemFor, classifyField, customAnswers, screeningFillValues, screeningKey, screeningRefusal } from '../src';

const classify = (label: string, type = 'text') => classifyField({ label, type, tag: 'input' });

describe('SCR-1: ordinary screening questions are recognised', () => {
  it.each([
    ['What is your notice period?', 'noticePeriod'],
    ['Salary expectations', 'salaryExpectation'],
    ['Expected salary (£)', 'salaryExpectation'],
    ['Day rate', 'dayRate'],
    ['How many years of experience do you have?', 'yearsExperience'],
    ['Are you willing to relocate?', 'relocation'],
    ['Are you willing to travel?', 'travel'],
    ['Do you hold a full UK driving licence?', 'drivingLicence'],
    ['Préavis', 'noticePeriod'],
    ['Prétentions salariales', 'salaryExpectation'],
    ['Permis de conduire', 'drivingLicence'],
  ])('"%s" -> %s, not sensitive', (label, key) => {
    expect(classify(label)).toMatchObject({ sensitive: false, key });
  });
});

describe('SCR-3: a declaration is never answered from storage', () => {
  it.each([
    'Do you have any unspent convictions? Please state your notice period if not.',
    'Will you require visa sponsorship to relocate?',
    'I declare that my salary expectations above are accurate',
    'Do you have a disability that affects your driving licence?',
  ])('"%s" is sensitive and has no screening key', (label) => {
    const c = classify(label);
    expect(c.sensitive).toBe(true);
    expect(['noticePeriod', 'salaryExpectation', 'dayRate', 'yearsExperience', 'relocation', 'travel', 'drivingLicence']).not.toContain(c.key);
  });

  it('a sensitive question is refused for storage; an ordinary one is accepted', () => {
    expect(screeningRefusal('Have you ever been convicted of an offence?')).toMatch(/convictions question/);
    expect(screeningRefusal('Do you need sponsorship?')).toMatch(/right-to-work question/);
    expect(screeningRefusal('I confirm the above is true')).toMatch(/declaration question/);
    expect(screeningRefusal('Can you work weekends?')).toBeUndefined();
    expect(screeningRefusal('   ')).toMatch(/empty/);
  });

  it('a stored custom answer whose question has become sensitive is not handed out', () => {
    const answers = { custom: { 'Can you work weekends?': 'Yes', 'Any criminal convictions?': 'No', 'Blank?': '  ' } };
    expect(customAnswers(answers)).toEqual({ 'can you work weekends': 'Yes' });
  });
});

describe('screening values', () => {
  it('maps stored answers to fill values and skips the empty ones', () => {
    expect(screeningFillValues({ noticePeriod: ' 4 weeks ', salaryExpectation: '', relocation: false, drivingLicence: true, custom: {} })).toEqual({ noticePeriod: '4 weeks', relocation: false, drivingLicence: true });
    expect(screeningFillValues(undefined)).toEqual({});
  });

  it('keys a question the way the page label will be keyed', () => {
    expect(screeningKey('Are you able to work NIGHTS?')).toBe('are you able to work nights');
    expect(screeningKey('Are you able to work nights')).toBe(screeningKey('are you able to work nights?'));
  });
});

describe('APP-9: application systems', () => {
  it('recognises the known systems by host and nothing else', () => {
    expect(applicationSystemFor('https://boards.greenhouse.io/example/jobs/1')?.id).toBe('greenhouse');
    expect(applicationSystemFor('https://jobs.lever.co/example/abc')?.id).toBe('lever');
    expect(applicationSystemFor('https://jobs.ashbyhq.com/example/1')?.id).toBe('ashby');
    expect(applicationSystemFor('http://127.0.0.1:8123/apply')?.id).toBe('local-fixture');
    expect(applicationSystemFor('https://greenhouse.io.example.org/apply')).toBeUndefined();
    expect(applicationSystemFor('https://www.jobs.nhs.uk/candidate/jobadvert/1')).toBeUndefined();
    expect(applicationSystemFor('not a url')).toBeUndefined();
  });

  it('only the fictional-forms entry is test-only', () => {
    expect(APPLICATION_SYSTEMS.filter((s) => s.testOnly).map((s) => s.id)).toEqual(['local-fixture']);
  });
});
