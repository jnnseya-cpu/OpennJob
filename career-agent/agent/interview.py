"""Interview preparation from the exact materials sent for one application (R18, B17; T47, T48).

  python3 -m agent.interview --job ID                      questions for this role, from its advert and your documents
  python3 -m agent.interview --job ID --answer-file a.txt   feedback on a practice answer

Everything is grounded in the sealed attempt: the job description and the CV, cover letter and
answers actually submitted (or, before any attempt, the prepared pack). The questions come from
the advert's requirements, quoted; gaps become "how would you answer" questions, never invented
stories. Feedback flags any figure, date, organisation or credential in the answer that the
submitted materials do not contain. The LLM coach is optional, runs under the spending budget,
and on any failure the deterministic feedback is still given. Practice is never an application.
"""
import argparse, json, re
from pathlib import Path
from . import paths
from .store import Store

STAR = {'situation': r'\b(when|while|at the time|on (a|the) project|we were)\b', 'task': r'\b(my (role|task|job|responsibility)|i was (asked|responsible))\b',
        'action': r'\b(i (led|managed|set up|introduced|negotiated|planned|ran|built|chaired|escalated|agreed|delivered))\b', 'result': r'\b(as a result|result(ed)?|saved|reduced|delivered|on time|under budget|which meant)\b'}
EMPLOYER_QUESTIONS = ['What would success look like in the first six months?', 'Which risks on the programme worry you most today?',
                      'How are decisions shared between client, contractor and supply chain here?', 'What is the reporting line and the size of the team?']


def materials(store, job_id):
    """The documents actually sent (latest attempt), else the prepared pack. Raises if neither exists."""
    job = store.job(job_id); app = store.application(job_id)
    if not job or not app:
        raise LookupError('Prepare the actual application first')
    p = app['payload']; attempts = store.attempts(job_id)
    snapshot = json.loads(attempts[-1]['snapshot']) if attempts and attempts[-1].get('snapshot') else None
    return {'job': job, 'jd': snapshot['jd']['normalized_text'] if snapshot else job.get('description', ''), 'cv': p.get('cv_text', ''), 'cover': p.get('cover_letter', ''),
            'answers': snapshot['answers'] if snapshot else p.get('answers', []), 'requirements': snapshot['scorecard']['requirements'] if snapshot else job.get('requirements', []),
            'sent': bool(snapshot), 'attempt_id': attempts[-1]['id'] if attempts else None}


def questions(m):
    out = []
    for r in m['requirements']:
        quote = r.get('jd_quote') or r['text']
        if r['state'] in ('met', 'partial'):
            out.append({'requirement': r['text'], 'question': f'The advert asks for “{quote}”. Tell me about a time you did this: the situation, your part, what you did and the result.', 'kind': 'evidence'})
        else:
            out.append({'requirement': r['text'], 'question': f'The advert asks for “{quote}”, which your application did not evidence. How would you answer honestly if asked?', 'kind': 'gap'})
    return {'role': f"{m['job'].get('title', '')} — {m['job'].get('company', '')}", 'from_submitted_materials': m['sent'], 'questions': out, 'questions_for_employer': EMPLOYER_QUESTIONS}


def _facts(text):
    figures = set(re.findall(r'(?<![\w])[£$€]?\d[\d,.]*(?:[kKmM]|bn)?\b', text))
    names = set(re.findall(r'\b[A-Z][A-Za-z&]+(?:\s+[A-Z][A-Za-z&]+)+\b', text)) | set(re.findall(r'\b[A-Z]{2,}[A-Z0-9]*\b', text))
    return figures, names


def check(answer, m):
    """Deterministic feedback: STAR structure and claims the submitted materials do not support."""
    source = '\n'.join([m['cv'], m['cover'], m['jd'], ' '.join(str(a.get('value', '')) for a in m['answers'])])
    figures, names = _facts(answer)
    unsupported = sorted([f for f in figures if f.lstrip('£$€').rstrip('kKmMbn').rstrip('.,') not in source] +
                         [n for n in names if n not in source and n.split()[0] not in ('I', 'The', 'When', 'We', 'My', 'As', 'In', 'On', 'At')])
    present = {k: bool(re.search(v, answer, re.I)) for k, v in STAR.items()}
    improvements = [f'Say more about the {k}.' for k, ok in present.items() if not ok]
    if unsupported:
        improvements.append('Some details are not in what you sent; be ready to back them up or leave them out: ' + ', '.join(unsupported))
    return {'star': present, 'unsupported_claims': unsupported, 'improvements': improvements or ['Clear and grounded in your application.'], 'source': 'deterministic'}


def practice(store, job_id, question, answer, use_llm=False):
    m = materials(store, job_id)
    feedback = check(answer, m)
    if use_llm:
        try:
            from .llm import call
            ai = call('Coach this practice answer against the actual application documents. Return {"strengths":[str],"improvements":[str],"unsupported_claims":[str],"follow_up_question":str}. Never invent personal stories.',
                      {'question': question, 'answer': answer, 'submitted': {'cv': m['cv'], 'cover': m['cover'], 'jd': m['jd']}}, store, 'coach')
            feedback.update(ai=ai, source='deterministic+llm')
        except Exception as e:
            feedback.update(llm_error=f'The AI coach is unavailable ({type(e).__name__}); the checks above still apply.')
    return {'question': question, 'feedback': feedback, 'application': job_id, 'practice_only': True}


def main(argv=None):
    p = argparse.ArgumentParser(prog='python3 -m agent.interview'); p.add_argument('--job', required=True); p.add_argument('--answer-file'); p.add_argument('--question', default='Practice question'); p.add_argument('--ai', action='store_true')
    a = p.parse_args(argv); s = Store(paths.db_path())
    try:
        if a.answer_file:
            print(json.dumps(practice(s, a.job, a.question, Path(a.answer_file).read_text(encoding='utf-8'), a.ai), indent=2, ensure_ascii=False))
        else:
            print(json.dumps(questions(materials(s, a.job)), indent=2, ensure_ascii=False))
    except LookupError as e:
        raise SystemExit(str(e))
    finally:
        s.close()


if __name__ == '__main__':
    main()
