"""Preparation grounded in the exact materials submitted for this job."""
import argparse,json
from pathlib import Path
from .core import Store
from .llm import call,SYSTEM
from . import paths
def main():
    p=argparse.ArgumentParser();p.add_argument('--job',required=True);p.add_argument('--answer-file');a=p.parse_args();s=Store(paths.db_path())
    job=next((j for j in s.jobs() if j['id']==a.job),None)
    if not job:raise SystemExit('Unknown --job');application=next((x for x in s.applications() if x['job_id']==a.job),None)
    if not application:raise SystemExit('Prepare the actual application first')
    pack=application['payload'];profile=paths.read('profile.json')
    task='Return {"questions":[str],"stories":[{"evidence_id":str,"prompts":[str]}],"questions_for_employer":[str],"first_30_days":[str]}. Build an interview preparation brief from this exact CV, cover letter and JD. Separate missing facts from evidence. Never invent candidate stories.'
    data={'job':job,'submitted_materials':{k:pack.get(k) for k in ('cv_text','cover_letter','evidence_ids')},'profile':profile}
    if a.answer_file:
        data['practice_answer']=Path(a.answer_file).read_text();task='Return {"strengths":[str],"improvements":[str],"unsupported_claims":[str],"follow_up_question":str}. Coach this practice answer against the actual application documents.'
    print(json.dumps(call(task,data),indent=2))
if __name__=='__main__':main()
