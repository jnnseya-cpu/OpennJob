"""LLM spending: a hard limit, reserved before every call, accounted after (R20, B14; T42).

  LLM_BUDGET_GBP_DAILY              required for any live call (London day)
  LLM_BUDGET_GBP_TOTAL              optional overall cap
  LLM_PRICE_GBP_PER_MTOK_INPUT      price per million input tokens
  LLM_PRICE_GBP_PER_MTOK_OUTPUT     price per million output tokens
  LLM_UNKNOWN_PRICE_RESERVE_GBP     when prices are not set: the amount reserved and charged per call

Before a call the worst case (estimated input + the maximum output) is reserved; if that would
pass a limit there is no call. After a successful call the actual cost replaces the
reservation. A timeout or dropped connection keeps the full reservation as spent, because the
provider may have charged; an LLM call is never retried automatically. Match-call counts alone
are not a currency budget.
"""
import os
from decimal import Decimal, InvalidOperation
from .store import london_day, now


class BudgetExceeded(RuntimeError):
    pass


class BudgetNotConfigured(RuntimeError):
    pass


def _money(name):
    raw = os.getenv(name)
    if raw in (None, ''):
        return None
    try:
        v = Decimal(raw)
    except InvalidOperation:
        raise BudgetNotConfigured(f'{name} is not a number')
    if not v.is_finite() or v < 0:
        raise BudgetNotConfigured(f'{name} must be zero or more')
    return v


def settings():
    daily = _money('LLM_BUDGET_GBP_DAILY')
    if daily is None:
        raise BudgetNotConfigured('Set LLM_BUDGET_GBP_DAILY before any live LLM analysis')
    pin, pout, reserve = _money('LLM_PRICE_GBP_PER_MTOK_INPUT'), _money('LLM_PRICE_GBP_PER_MTOK_OUTPUT'), _money('LLM_UNKNOWN_PRICE_RESERVE_GBP')
    if (pin is None or pout is None) and reserve is None:
        raise BudgetNotConfigured('Set LLM token prices, or LLM_UNKNOWN_PRICE_RESERVE_GBP for unknown pricing')
    return {'daily': daily, 'total': _money('LLM_BUDGET_GBP_TOTAL'), 'in': pin, 'out': pout, 'reserve': reserve}


def cost(s, input_tokens, output_tokens):
    if s['in'] is None or s['out'] is None:
        return s['reserve']
    return (Decimal(input_tokens) * s['in'] + Decimal(output_tokens) * s['out']) / Decimal(1_000_000)


def spent(store, day=None):
    row = store.db.execute("SELECT COALESCE(SUM(CASE WHEN status='reserved' THEN reserved ELSE COALESCE(actual, reserved) END),0) FROM usage WHERE local_day=?", (day or london_day(),)).fetchone()
    return Decimal(str(row[0]))


def spent_total(store):
    row = store.db.execute("SELECT COALESCE(SUM(CASE WHEN status='reserved' THEN reserved ELSE COALESCE(actual, reserved) END),0) FROM usage").fetchone()
    return Decimal(str(row[0]))


def reserve(store, model, purpose, input_chars, max_output_tokens):
    s = settings()
    worst = cost(s, (input_chars // 3) + 1, max_output_tokens)
    refused = None
    with store.tx():
        if spent(store) + worst > s['daily']:
            refused = ('daily', f'Daily LLM budget of £{s["daily"]} would be passed; analysis paused until tomorrow')
        elif s['total'] is not None and spent_total(store) + worst > s['total']:
            refused = ('total', f'Total LLM budget of £{s["total"]} would be passed; analysis paused')
        else:
            cur = store.db.execute('INSERT INTO usage(at,local_day,provider,model,purpose,status,reserved) VALUES(?,?,?,?,?,?,?)',
                                   (now(), london_day(), 'openai-responses', model, purpose, 'reserved', float(worst)))
            return cur.lastrowid
    # Recorded after the transaction, so the refusal itself is never rolled back.
    store.event('budget_reached', {'purpose': purpose, 'limit': refused[0]})
    raise BudgetExceeded(refused[1])


def settle(store, usage_id, input_tokens, output_tokens):
    s = settings()
    store.db.execute("UPDATE usage SET status='ok', actual=?, input_tokens=?, output_tokens=? WHERE id=?",
                     (float(cost(s, input_tokens, output_tokens)), input_tokens, output_tokens, usage_id))


def failed(store, usage_id, charged_possible=True):
    # Possibly charged (timeout, dropped connection): the whole reservation stays spent.
    store.db.execute("UPDATE usage SET status=?, actual=CASE WHEN ? THEN reserved ELSE 0 END WHERE id=?",
                     ('uncertain' if charged_possible else 'failed', 1 if charged_possible else 0, usage_id))


def summary(store):
    try:
        s = settings(); limit = str(s['daily'])
    except BudgetNotConfigured as e:
        limit = 'not configured: ' + str(e)
    calls = store.db.execute('SELECT status, COUNT(*) FROM usage WHERE local_day=? GROUP BY status', (london_day(),)).fetchall()
    return {'today_gbp': str(spent(store)), 'daily_limit_gbp': limit, 'calls_today': {r[0]: r[1] for r in calls}}
