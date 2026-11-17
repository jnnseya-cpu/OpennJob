"""Package comparison and salary questions (R08, R28; T49).

History is not a floor. A previous salary, bonus or allowance describes the past; a target
day rate is a target. Neither becomes a minimum, a filter or an answer to "expected salary"
unless the applicant confirmed that answer for that purpose. Packages are compared component
by component (salary, bonus, allowances, pension, currency, contract basis, day rate) and an
annual salary is never converted into a day rate, or back, without assumptions the applicant
supplied.
"""
from decimal import Decimal

COMPONENTS = ('base_salary', 'bonus', 'car_allowance', 'other_allowances', 'pension_employer_percent', 'day_rate', 'currency', 'contract_basis', 'benefits')


class NeedsApplicant(ValueError):
    """The answer must come from the applicant: nothing confirmed exists for this purpose."""


def expected_salary_answer(library, question_kind='permanent'):
    """The confirmed expected-salary (or day-rate) answer, or NeedsApplicant. Never derived from history."""
    key = 'expected_permanent_salary' if question_kind == 'permanent' else 'expected_day_rate'
    item = (library or {}).get('answers', {}).get(key) or {}
    if item.get('confirmed') is True and item.get('value') not in (None, ''):
        return item['value']
    raise NeedsApplicant(f'{key.replace("_", " ").capitalize()} is not confirmed. Previous salary and target rates are history and targets, not your answer.')


def minimum_filter(profile):
    """Only an explicitly confirmed hard minimum filters roles. History and targets never do."""
    m = (profile or {}).get('confirmed_minimums') or {}
    return {k: Decimal(str(v)) for k, v in m.items() if v not in (None, '')}


def compare(packages, assumptions=None):
    """Side-by-side components. Totals only within one currency and basis, and only for supplied numbers.

    Day rate and annual salary are kept apart unless assumptions give working days per year.
    Returns {'rows': [...], 'notes': [...]}.
    """
    assumptions = assumptions or {}
    rows, notes = [], []
    for name, p in packages.items():
        row = {'package': name}
        for c in COMPONENTS:
            row[c] = p.get(c, 'unknown')
        cash = [p.get(k) for k in ('base_salary', 'bonus', 'car_allowance', 'other_allowances')]
        if all(isinstance(x, (int, float, Decimal)) for x in cash[:1]) and p.get('contract_basis', 'permanent') == 'permanent':
            row['annual_cash_known'] = str(sum(Decimal(str(x)) for x in cash if isinstance(x, (int, float, Decimal))))
        else:
            row['annual_cash_known'] = 'not comparable'
        if isinstance(p.get('day_rate'), (int, float, Decimal)):
            days = assumptions.get('working_days_per_year')
            if days:
                row['day_rate_annualised'] = str(Decimal(str(p['day_rate'])) * Decimal(str(days)))
                notes.append(f'{name}: day rate annualised over {days} days you supplied; tax, holiday and employment basis differ.')
            else:
                row['day_rate_annualised'] = 'not computed: supply working days per year'
        rows.append(row)
    currencies = {p.get('currency', 'unknown') for p in packages.values()}
    if len(currencies) > 1:
        notes.append('Different currencies: totals are not compared across them.')
    return {'rows': rows, 'notes': notes}
