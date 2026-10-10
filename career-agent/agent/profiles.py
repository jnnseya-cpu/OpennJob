"""Search profiles (R02, B05; T06).

Three profiles from one factual ledger: UK permanent, UK contract and international. A job's
membership comes from its country and work type, never from a guess: an unconfirmed country
belongs to no profile until it is confirmed, and an unconfirmed work type belongs to both UK
profiles with a flag. The title prefilter is only for cost: it is tuned to keep construction,
project and delivery leadership variants (director, head, lead, package and subcontract roles)
and is tested for recall on labelled titles. It never decides the 80% score.
"""
import re

UK = {'united kingdom', 'uk', 'gb', 'great britain', 'england', 'scotland', 'wales', 'northern ireland'}
DOMAIN = re.compile(r'construct|project|programme|program\b|\bepc\b|\bsite\b|package|delivery|subcontract|infrastructure|\bgrid\b|substation|'
                    r'energy|power|data ?cent|mission[- ]critical|commissioning|\bmep\b|electrical|transmission|renewable|rail|highways|utilities|build', re.I)
ROLE = re.compile(r'manager|director|\blead\b|\bhead\b|controller|principal|superintendent|\bpm\b', re.I)
EXCLUDE = re.compile(r'graduate|apprentice|intern\b|trainee|assistant (project|site)|administrator|coordinator|accountant|marketing|sales|recruit', re.I)


def title_matches(title):
    t = title or ''
    return bool(DOMAIN.search(t) and ROLE.search(t) and not EXCLUDE.search(t))


def work_type(job):
    raw = ' '.join(str(job.get(k, '')) for k in ('work_type', 'employment_type', 'contract_type')).lower()
    title = (job.get('title') or '').lower()
    if re.search(r'contract|interim|freelance|temporary|\btemp\b|fixed[- ]term|day rate|ir35', raw + ' ' + title):
        return 'contract'
    if re.search(r'permanent|full[- ]time|\bperm\b', raw):
        return 'permanent'
    return 'unconfirmed'


def memberships(job, profiles):
    """[(profile_id, flags)] for every profile the job belongs to."""
    country = (job.get('country') or 'Unconfirmed').strip()
    if country.lower() in ('', 'unconfirmed'):
        return []
    in_uk = country.lower() in UK
    kind = work_type(job)
    out = []
    for p in profiles:
        countries = [c.lower() for c in p.get('countries', [])]
        if 'any_non_uk' in countries:
            if in_uk:
                continue
        elif country.lower() not in countries and not (in_uk and 'united kingdom' in countries):
            continue
        types = p.get('work_types', [])
        if kind == 'unconfirmed':
            out.append((p['id'], ['work_type_unconfirmed']))
        elif kind in types:
            out.append((p['id'], []))
    return out


def apply(job, profiles):
    """Records the memberships. Preferences count as confirmed only through a profile the applicant confirmed."""
    members = memberships(job, profiles)
    confirmed = {p['id'] for p in profiles if p.get('confirmed') is True}
    job['profile_ids'] = [m[0] for m in members]
    job['profile_flags'] = sorted({f for _, flags in members for f in flags})
    if any(pid in confirmed for pid, flags in members if not flags):
        job['preferences_confirmed'] = True
    return job
