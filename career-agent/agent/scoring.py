"""Exact weighted coverage (R04, R05, R06; T11, T12).

coverage = 100 x sum(weight x finding) / sum(weight), finding met=1, partial=0.5,
unknown/unmet=0, in Decimal. Eligibility is raw coverage >= 80: nothing is rounded before
the comparison, so 79.999 is not eligible. Display may floor; it never decides.
A model scorecard must have finite positive weights totalling exactly 100, a known state
for every requirement and an essential (hard) flag.
"""
from decimal import Decimal, InvalidOperation, ROUND_FLOOR

FINDING = {'met': Decimal(1), 'partial': Decimal('0.5'), 'unknown': Decimal(0), 'unmet': Decimal(0)}
THRESHOLD = Decimal(80)


def _weight(value):
    if isinstance(value, bool):
        raise ValueError('Weight must be a number')
    try:
        w = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        raise ValueError('Weight must be a number')
    if not w.is_finite():
        raise ValueError('Weight must be finite')
    if not Decimal(0) < w <= Decimal(100):
        raise ValueError('Weight must be above 0 and at most 100')
    return w


def raw_coverage(requirements):
    if not requirements:
        return Decimal(0)
    total = Decimal(0); met = Decimal(0)
    for r in requirements:
        if r.get('state') not in FINDING:
            raise ValueError('Invalid requirement state')
        w = _weight(r.get('weight'))
        total += w; met += w * FINDING[r['state']]
    return Decimal(100) * met / total


def eligible(requirements, threshold=THRESHOLD):
    threshold = Decimal(str(threshold))
    if threshold < THRESHOLD:
        raise ValueError('Minimum threshold is 80')
    return raw_coverage(requirements) >= threshold


def display(requirements):
    """For people: the floor of the raw coverage. Never used to decide."""
    return int(raw_coverage(requirements).to_integral_value(rounding=ROUND_FLOOR))


def as_text(value):
    """raw_coverage as the snapshot string: plain digits, no exponent, up to 6 places."""
    q = value.quantize(Decimal('0.000001')).normalize()
    text = format(q, 'f')
    return '100' if q == 100 else text


def validate_scorecard(requirements, job_text=None, require_total_100=True):
    if not isinstance(requirements, list) or not requirements:
        raise ValueError('No requirements extracted')
    total = Decimal(0)
    for r in requirements:
        if not isinstance(r, dict):
            raise ValueError('Requirement must be an object')
        if not isinstance(r.get('hard'), bool):
            raise ValueError('Essential classification missing')
        if r.get('state') not in FINDING:
            raise ValueError('Invalid requirement state')
        total += _weight(r.get('weight'))
        if job_text is not None:
            quote = r.get('jd_quote')
            if not quote or quote not in job_text:
                raise ValueError('Requirement quote not present in JD')
    if require_total_100 and total != Decimal(100):
        raise ValueError('Weights must total 100')
    return raw_coverage(requirements)
