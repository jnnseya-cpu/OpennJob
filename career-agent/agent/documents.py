"""Deterministic, extractive application packs.

Every achievement line in the CV and the cover letter is copied exactly from the
applicant's evidence ledger. Nothing is rewritten, summarised or invented. Titles, dates
and qualification names come from the profile as given; a missing date is left out, never
filled in. The same inputs always produce byte-identical files, so a sealed pack can be
checked again just before the applicant submits it.

Output per job: cv.pdf, cv.docx, cover.pdf, cover.docx, jd_snapshot.txt, scorecard.json.
"""
import hashlib, io, json, re, zipfile
from datetime import datetime
from pathlib import Path
from .core import score
from .policy import pack_digest

PLACEHOLDER = re.compile(r'\[[^\]]*\b(required|confirm|todo|tbc)\b[^\]]*\]|REPLACE_WITH|PLACEHOLDER|\bTODO\b', re.I)
FIXED = datetime(2000, 1, 1)


class PackError(ValueError):
    pass


def evidence_order(job, profile):
    """Evidence cited by met, then partial, requirements, heaviest first. Only cited evidence."""
    ledger = {e['id']: e for e in profile.get('evidence', [])}
    rank = {'met': 0, 'partial': 1}
    reqs = sorted((r for r in job.get('requirements', []) if r.get('state') in rank), key=lambda r: (rank[r['state']], -float(r['weight'])))
    ids = list(dict.fromkeys(i for r in reqs for i in r.get('evidence_ids', [])))
    if not ids:
        raise PackError('No cited evidence: nothing truthful to put in a tailored pack')
    unknown = [i for i in ids if i not in ledger]
    if unknown:
        raise PackError('Unknown evidence citation: ' + ', '.join(unknown))
    unconfirmed = [i for i in ids if not ledger[i].get('verified')]
    if unconfirmed:
        raise PackError('Evidence not confirmed by the applicant: ' + ', '.join(unconfirmed))
    return ids, ledger


def employment_lines(profile):
    lines = []
    for e in profile.get('employment', []):
        dates = '–'.join(x for x in (e.get('start'), e.get('end')) if x)
        lines.append(' | '.join(x for x in (f"{e['employer']} — {e['title']}", e.get('location', ''), dates) if x))
    return lines


def texts(job, profile, ids, ledger):
    contact = ' | '.join(x for x in (profile.get('location'), profile.get('email'), profile.get('phone')) if x)
    cv = [profile['name'], profile.get('headline') or job['title'], contact, '', 'RELEVANT EXPERIENCE']
    cv += ['• ' + ledger[i]['text'] for i in ids]
    jobs = employment_lines(profile)
    if jobs:
        cv += ['', 'EMPLOYMENT'] + jobs
    if profile.get('qualifications'):
        cv += ['', 'QUALIFICATIONS'] + list(profile['qualifications'])
    cover = [
        'Dear Hiring Manager,', '',
        f"I am applying for the {job['title']} role at {job['company']}. The points below are taken from my CV and relate to the requirements of the role.", '',
    ] + ['• ' + ledger[i]['text'] for i in ids] + [
        '', 'I would welcome a discussion of the role and the contribution my experience could make.', '', 'Yours sincerely,', profile['name'],
    ]
    return '\n'.join(cv), '\n'.join(cover)


def write_pdf(text, path):
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas
    from reportlab.lib.utils import simpleSplit
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4, invariant=1, pageCompression=0)
    c.setTitle(path.stem); c.setAuthor(''); c.setCreator(''); c.setProducer('')
    width, height = A4
    y = height - 56
    for i, raw in enumerate(text.split('\n')):
        bold = i == 0 or raw.isupper()
        font, size = ('Helvetica-Bold', 15 if i == 0 else 11) if bold else ('Helvetica', 10.5)
        for line in simpleSplit(raw, font, size, width - 112) or ['']:
            if y < 56:
                c.showPage(); y = height - 56
            c.setFont(font, size); c.drawString(56, y, line); y -= size + 5
    c.save()
    path.write_bytes(buf.getvalue())


def write_docx(text, path):
    from docx import Document
    d = Document()
    cp = d.core_properties
    cp.author = ''; cp.last_modified_by = ''; cp.created = FIXED; cp.modified = FIXED; cp.revision = 1
    for i, line in enumerate(text.split('\n')):
        if i == 0:
            d.add_heading(line, level=1)
        elif line.isupper() and line:
            d.add_heading(line, level=2)
        else:
            d.add_paragraph(line)
    raw = io.BytesIO(); d.save(raw)
    # Rewrite the zip with fixed timestamps so identical content gives identical bytes.
    out = io.BytesIO()
    with zipfile.ZipFile(raw) as src, zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as dst:
        for name in sorted(src.namelist()):
            info = zipfile.ZipInfo(name, date_time=(2000, 1, 1, 0, 0, 0)); info.compress_type = zipfile.ZIP_DEFLATED
            dst.writestr(info, src.read(name))
    path.write_bytes(out.getvalue())


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def build(job, profile, out_dir):
    """Builds and seals the pack for one job. Raises PackError rather than produce a placeholder."""
    for field in ('name', 'email', 'phone'):
        if not profile.get(field):
            raise PackError('Profile is missing ' + field)
    ids, ledger = evidence_order(job, profile)
    cv_text, cover_text = texts(job, profile, ids, ledger)
    for label, t in (('CV', cv_text), ('cover letter', cover_text)):
        if PLACEHOLDER.search(t):
            raise PackError(f'The {label} contains a placeholder or review note; fix the profile first')
    out = Path(out_dir); out.mkdir(parents=True, exist_ok=True)
    docs = {'cv': out / 'cv.pdf', 'cover': out / 'cover.pdf', 'cv_docx': out / 'cv.docx', 'cover_docx': out / 'cover.docx'}
    write_pdf(cv_text, docs['cv']); write_pdf(cover_text, docs['cover'])
    write_docx(cv_text, docs['cv_docx']); write_docx(cover_text, docs['cover_docx'])
    (out / 'jd_snapshot.txt').write_text(job.get('description', ''), encoding='utf-8')
    (out / 'scorecard.json').write_text(json.dumps({'score': score(job.get('requirements', [])), 'requirements': job.get('requirements', [])}, indent=2, sort_keys=True), encoding='utf-8')
    pack = {
        'job_id': job['id'], 'url': job.get('url'), 'cv_text': cv_text, 'cover_letter': cover_text, 'evidence_ids': ids,
        'match_score': score(job.get('requirements', [])), 'documents': {k: str(v) for k, v in docs.items()},
        'document_hashes': {k: sha(v) for k, v in docs.items()}, 'generation_mode': 'extractive_v1',
        'profile': {k: profile.get(k) for k in ('name', 'email', 'phone', 'location')},
        'human_reviewed': False,
    }
    pack['integrity'] = pack_digest(pack)
    return pack
