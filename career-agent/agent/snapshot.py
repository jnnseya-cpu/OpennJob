"""The sealed attempt snapshot (R11, B09; T26, T30, T31).

Before any click the agent seals exactly what will be sent: the JD version and its hash, the
scorecard, the versions of the profile, policy and answers, every answer it filled, the CV and
cover-letter files and their hashes, the route and its certification. The snapshot is checked
against contracts/attempt-snapshot.schema.json and the runtime contract checks, stored in the
ledger with the claim, and written once to packs/<job>/attempts/<attempt>/ together with copies
of the documents. Nothing there is ever overwritten: a later regeneration writes new files
elsewhere, so what was sent can always be reconstructed.
"""
import hashlib, json, os, shutil
from pathlib import Path
from . import paths
from .contracts import child_path, validate_snapshot
from .normalize import PARSER_VERSION, digest, normalize
from .scoring import as_text, raw_coverage
from .store import now

PROMPT_VERSION = 'prompt-' + hashlib.sha256(b'nseya-match-tailor-v1').hexdigest()[:12]
DOC_KINDS = {'cv': 'cv', 'cover': 'cover'}


def sha_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def build(attempt_id, job, pack, filled, adapter, form_schema_hash, input_versions, policy, applicant_id='applicant'):
    text = normalize(job.get('description', ''))
    reqs = [{k: r[k] for k in ('text', 'jd_quote', 'weight', 'state', 'hard')} | {'evidence_ids': list(dict.fromkeys(r.get('evidence_ids', [])))}
            for r in job.get('requirements', [])]
    snapshot = {
        'schema_version': 1,
        'attempt_id': attempt_id,
        'applicant_id': applicant_id,
        'tenant_id': None,
        'posting_id': str(job.get('posting_id') or job['id']),
        'jd': {'version_id': 'jd-' + digest(text)[:16], 'jd_url': job.get('jd_url') or job['url'], 'apply_url': job['url'], 'normalized_text': text,
               'sha256': digest(text), 'fetched_at': job.get('verified_at') or job.get('fetched_at') or now(), 'country': job.get('country') or 'Unconfirmed'},
        'versions': {'profile': input_versions['profile'], 'policy': input_versions['policy'], 'answers': input_versions['answers'],
                     'model_prompt': PROMPT_VERSION, 'parser': PARSER_VERSION},
        'scorecard': {'requirements': reqs, 'raw_coverage': as_text(raw_coverage(job.get('requirements', []))), 'reviewed': bool(job.get('matching_reviewed'))},
        'documents': [{'kind': kind, 'artifact_id': f'{attempt_id}/{Path(pack["documents"][kind]).name}', 'sha256': pack['document_hashes'][kind], 'mime_type': 'application/pdf'}
                      for kind in DOC_KINDS if kind in pack.get('documents', {})],
        'answers': [{'question_id': f['selector'], 'answer_key': f['key'], 'value': f['value'], 'confirmation_version': input_versions['answers']} for f in filled],
        'prepared_at': now(),
        'authorization': {'version': input_versions['policy'], 'enabled': bool(policy.get('enabled')), 'minimum_match': policy.get('minimum_match', 80)},
        'adapter': {'id': adapter.get('id', 'route'), 'version': adapter_version(adapter),
                    'certification_id': (adapter.get('certification') or {}).get('id', 'NOT-CERTIFIED'), 'form_schema_hash': form_schema_hash},
    }
    return validate_snapshot(snapshot)


def adapter_version(adapter):
    body = {k: v for k, v in adapter.items() if k not in ('certification', 'note')}
    return 'route-' + hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()[:16]


def seal(snapshot, pack, job_id):
    """Writes the snapshot and copies of the documents once. Returns (path, sha256). Never overwrites."""
    raw = json.dumps(snapshot, sort_keys=True, ensure_ascii=False, indent=1).encode('utf-8')
    folder = child_path(paths.sub('packs'), job_id, 'attempts', snapshot['attempt_id'])
    folder.mkdir(parents=True, exist_ok=False)
    for kind in DOC_KINDS:
        if kind in pack.get('documents', {}):
            source = Path(pack['documents'][kind]); target = folder / source.name
            shutil.copyfile(source, target)
            if sha_file(target) != pack['document_hashes'][kind]:
                raise ValueError('Document changed while sealing')
            os.chmod(target, 0o444)
    path = folder / 'snapshot.json'
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o444)
    with os.fdopen(fd, 'wb') as f:
        f.write(raw)
    return path, hashlib.sha256(raw).hexdigest()


def export(store, job_id):
    """Everything needed to reconstruct an attempt (T31): JD, scorecard, versions, documents, answers, attempt, receipt."""
    out = []
    for a in store.attempts(job_id):
        snapshot = json.loads(a['snapshot']) if a['snapshot'] else None
        folder = child_path(paths.sub('packs'), job_id, 'attempts', a['id'])
        docs = {p.name: sha_file(p) for p in sorted(folder.glob('*.pdf'))} if folder.is_dir() else {}
        out.append({'attempt': {k: a[k] for k in ('id', 'actor', 'claimed_at', 'clicked_at', 'finished_at', 'status', 'receipt', 'snapshot_sha256')},
                    'snapshot': snapshot, 'documents_on_disk': docs,
                    'documents_match': bool(snapshot) and all(docs.get(Path(d['artifact_id']).name) == d['sha256'] for d in snapshot['documents'])})
    return {'job': store.job(job_id), 'application': store.application(job_id), 'attempts': out, 'outcomes': store.outcomes(job_id)}
