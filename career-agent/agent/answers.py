"""Confirmed screening answers; never infer legally significant answers.

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


def answer(key, library):
    item = library.get('answers', {}).get(key)
    if not item or not item.get('confirmed') or item.get('value') is None:
        raise ValueError('Confirmed answer required: ' + key)
    return item['value']


def resolve(field, pack, library):
    key = field['key']
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
