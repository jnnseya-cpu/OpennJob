"""Confirmed screening answers; never infer legally significant answers.

Right to work and sponsorship are the one exception, and only through agent/rights.py: a field
marked "source": "work_rights" is answered from the applicant's confirmed, document-backed record
for the job's country. With no valid record the question goes back to the applicant.

Declarations are never filled by the agent. Work rights, sponsorship, visas, clearance and
vetting, convictions, conflicts of interest, health, disability, equality monitoring and any
consent or "I confirm" box are answered by the applicant on the form, every time. A
library entry may record such a fact for matching gates, but resolve() refuses to put it
into a form field.
"""
import re

DECLARATION_KINDS = {'declaration', 'legal', 'demographic', 'consent'}
DECLARATION_KEY = re.compile(
    r'right_to_work|sponsor|visa|work_permit|authori[sz]|criminal|conviction|caution|clearance|vetting|'
    r'conflict|health|disab|equal|gender|ethnic|religio|sexual|declar|consent|confirm|fitness|safeguard',
    re.I,
)


class LeftForApplicant(ValueError):
    """A field the applicant answers themselves on the form."""


def is_declaration(field, library=None):
    key = field.get('key', '')
    if field.get('declaration') or field.get('type') in ('checkbox', 'radio'):
        return True
    item = (library or {}).get('answers', {}).get(key) or {}
    return item.get('kind') in DECLARATION_KINDS or bool(DECLARATION_KEY.search(key))


# Keys whose answer must never be derived from history or a target (R08, T49).
NEVER_DERIVED = re.compile(r'expected|desired|salary_expect|day_rate_expect|notice|start_date|earlier_|chronolog|employment_dates', re.I)


def answer(key, library):
    item = library.get('answers', {}).get(key)
    if not item or not item.get('confirmed') or item.get('value') is None or item.get('value') == '':
        raise ValueError('Confirmed answer required: ' + key)
    if item.get('kind') == 'narrative':
        raise ValueError('A writing-style note is not an answer: ' + key)
    if item.get('derived_from'):
        raise ValueError('Derived answers are not accepted; confirm the value itself: ' + key)
    return item['value']


class AskApplicant(LeftForApplicant):
    """No confirmed answer exists: ask the applicant."""


def resolve(field, pack, library, profile=None, country=None):
    key = field['key']
    if field.get('source') == 'work_rights':
        from .rights import answer_for
        try:
            value = answer_for(key, profile or {}, country)
        except LookupError as e:
            raise AskApplicant(str(e))
        token = str(value).lower()
        if token not in field.get('value_map', {}):
            raise ValueError('Reviewed option mapping required: ' + key)
        return field['value_map'][token]
    if is_declaration(field, library):
        raise LeftForApplicant('Declaration left for the applicant: ' + key)
    if key == 'cover_letter':
        return pack['cover_letter']
    value = answer(key, library)
    if field.get('value_map'):
        token = str(value).lower() if isinstance(value, bool) else str(value)
        if token not in field['value_map']:
            raise ValueError('Reviewed option mapping required: ' + key)
        value = field['value_map'][token]
    return value
