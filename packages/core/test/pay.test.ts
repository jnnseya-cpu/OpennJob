import { describe, expect, it } from 'vitest';
import { jobPay, parseAmount, payExpectationOf, payFits, payInText } from '../src/pay';

/** Pay against the person's expectation. Fictional adverts. */
const job = (extra: { salaryMin?: number; salaryMax?: number; title?: string; description?: string }) => ({ title: 'Senior Project Manager (fictional)', description: 'A fictional vacancy.', ...extra });

describe('pay against the expectation', () => {
  it('reads the expectation as the person wrote it', () => {
    expect(parseAmount('£85,000')).toBe(85_000);
    expect(parseAmount('85k')).toBe(85_000);
    expect(parseAmount('85,000 - 95,000')).toBe(85_000);
    expect(parseAmount('£650 a day')).toBe(650);
    expect(parseAmount('negotiable')).toBeUndefined();
    expect(payExpectationOf({ salaryExpectation: '£80,000', dayRate: '£600' })).toEqual({ annual: 80_000, daily: 600 });
    expect(payExpectationOf(undefined)).toEqual({});
  });

  it('a salary under the expectation is out; one reaching it, or no salary, is in', () => {
    const want = { annual: 80_000 };
    expect(payFits(job({ salaryMin: 50_000, salaryMax: 65_000 }), want)).toBe(false);
    expect(payFits(job({ salaryMin: 70_000, salaryMax: 85_000 }), want)).toBe(true); // the top reaches it
    expect(payFits(job({}), want)).toBe(true); // no pay stated
    expect(payFits(job({ salaryMin: 50_000, salaryMax: 65_000 }), {})).toBe(true); // no expectation given
  });

  it('day rates are compared with the day rate, or the salary over 220 days', () => {
    expect(jobPay(job({ salaryMin: 450, salaryMax: 500 }))).toEqual({ top: 500, per: 'day' });
    expect(payFits(job({ salaryMax: 500 }), { daily: 600 })).toBe(false);
    expect(payFits(job({ salaryMax: 650 }), { daily: 600 })).toBe(true);
    expect(payFits(job({ salaryMax: 300 }), { annual: 80_000 })).toBe(false); // 80,000 / 220 = 364 a day
    expect(payFits(job({ salaryMax: 60 }), { daily: 600 })).toBe(false); // £60 an hour = £450 a day
  });

  it('pay written in the advert, not millions of project value', () => {
    expect(payInText('Salary: £50,000 - £65,000 per annum plus car')).toEqual({ top: 65_000, per: 'year' });
    expect(payInText('£500-£550 per day inside IR35')).toEqual({ top: 550, per: 'day' });
    expect(payInText('up to £70k plus benefits')).toEqual({ top: 70_000, per: 'year' });
    expect(payInText('Deliver a £25,000,000 hospital scheme')).toBeUndefined();
    expect(payInText('Leading £2m projects')).toBeUndefined();
    expect(payFits(job({ description: 'Senior PM. £50,000 - £65,000 per annum.' }), { annual: 80_000 })).toBe(false);
  });
});
