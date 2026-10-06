import { describe, expect, it } from 'vitest';
import { checkTraining, isoDateToUtcDay, trainingWarnings } from '../src';

const clock = () => new Date('2026-10-06T15:30:00Z');
const one = (expiresOn?: string) => checkTraining([{ name: 'BLS', ...(expiresOn ? { expiresOn } : {}) }], clock)[0];

describe('checkTraining', () => {
  it('flags expired training (expiry date before today)', () => {
    expect(one('2026-10-05')).toEqual({ name: 'BLS', expiresOn: '2026-10-05', status: 'expired', daysRemaining: -1 });
    expect(one('2020-01-01')?.status).toBe('expired');
  });
  it('treats the expiry day itself as expiring, not expired', () => {
    expect(one('2026-10-06')).toMatchObject({ status: 'expiring', daysRemaining: 0 });
  });
  it('flags training expiring within 30 days, inclusive', () => {
    expect(one('2026-10-07')).toMatchObject({ status: 'expiring', daysRemaining: 1 });
    expect(one('2026-11-05')).toMatchObject({ status: 'expiring', daysRemaining: 30 });
  });
  it('is valid from day 31', () => {
    expect(one('2026-11-06')).toMatchObject({ status: 'valid', daysRemaining: 31 });
    expect(one('2028-01-01')?.status).toBe('valid');
  });
  it('handles no expiry and unreadable dates', () => {
    expect(one()).toEqual({ name: 'BLS', status: 'no-expiry' });
    expect(one('06/10/2026')?.status).toBe('invalid-date');
    expect(one('2026-02-31')?.status).toBe('invalid-date');
  });
  it('uses the injected clock, not the system time', () => {
    const later = () => new Date('2027-01-01T00:00:00Z');
    expect(checkTraining([{ name: 'BLS', expiresOn: '2026-11-06' }], later)[0]?.status).toBe('expired');
  });
  it('does not depend on the time of day', () => {
    const lateNight = () => new Date('2026-10-06T23:59:59Z');
    const earlyMorning = () => new Date('2026-10-06T00:00:00Z');
    const t = [{ name: 'BLS', expiresOn: '2026-11-05' }];
    expect(checkTraining(t, lateNight)).toEqual(checkTraining(t, earlyMorning));
  });
});

describe('trainingWarnings', () => {
  it('lists only expired, expiring and unreadable items', () => {
    const w = trainingWarnings(
      [
        { name: 'A', expiresOn: '2026-10-01' },
        { name: 'B', expiresOn: '2026-10-20' },
        { name: 'C', expiresOn: '2027-10-20' },
        { name: 'D' },
        { name: 'E', expiresOn: 'soon' },
      ],
      clock,
    );
    expect(w).toEqual([
      'A expired on 2026-10-01',
      'B expires on 2026-10-20 (14 day(s) left)',
      'E has an unreadable expiry date "soon"',
    ]);
  });
});

describe('isoDateToUtcDay', () => {
  it('parses leap days and rejects impossible dates', () => {
    expect(isoDateToUtcDay('2028-02-29')).toBeTypeOf('number');
    expect(isoDateToUtcDay('2027-02-29')).toBeUndefined();
    expect(isoDateToUtcDay('2026-13-01')).toBeUndefined();
    expect(isoDateToUtcDay('nope')).toBeUndefined();
  });
});
