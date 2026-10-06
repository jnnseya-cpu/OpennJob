"""Two-hour discovery with a bounded LLM matching budget and visible errors."""
import argparse,json,time
from pathlib import Path
from .core import Store,score
from .sources import fetch
from . import llm, paths
def once(store,max_matches=10):
    profile=paths.read('profile.json');boards=paths.read('boards.json')
    # This is a broad cost prefilter only. It never establishes 80% eligibility.
    words=('construction','project manager','programme','program manager','epc','subcontract','delivery','site manager','package manager')
    matched=0
    for board in boards:
        try:
            jobs=fetch(board);store.event('source_ok',{'company':board['company'],'count':len(jobs)})
            old={j['id']:j for j in store.jobs()}
            for j in jobs:
                if not any(w in j['title'].lower() for w in words):continue
                j['description_full']=True
                previous=old.get(j['id']) or next((x for x in old.values() if x.get('company')==j['company'] and x.get('posting_id')==j.get('posting_id')),None)
                if previous:j['id']=previous['id']
                if previous and previous.get('description')==j['description']:
                    j=previous|j|{'requirements':previous.get('requirements',[]),'matching_reviewed':previous.get('matching_reviewed',False),'preferences_confirmed':previous.get('preferences_confirmed',False)}
                elif previous:
                    # A changed description invalidates every review made against the old one.
                    j=j|{'requirements':[],'matching_reviewed':False,'preferences_confirmed':False,'live_verified':False}
                    store.event('description_changed',{'job_id':j['id']})
                store.put_job(j)
                if not j['requirements'] and matched<max_matches:
                    matched+=1
                    try:store.put_job(llm.match(j,profile))
                    except Exception as e:store.event('matching_failed',{'job_id':j['id'],'reason':type(e).__name__})
            print(board['company'],len(jobs),'found',flush=True)
        except Exception as e:store.event('source_failed',{'company':board['company'],'reason':type(e).__name__});print('Source failed',board['company'],type(e).__name__,flush=True)
def main():
    p=argparse.ArgumentParser();p.add_argument('--once',action='store_true');p.add_argument('--max-matches',type=int,default=10);a=p.parse_args()
    if not 0<=a.max_matches<=100:raise SystemExit('Use a matching budget between 0 and 100 per source cycle')
    store=Store(paths.db_path())
    while True:
        once(store,a.max_matches)
        if a.once:break
        # Short sleeps keep interruptible operation; discovery interval remains two hours.
        deadline=time.monotonic()+paths.read('policy.json')['source_interval_seconds']
        while time.monotonic()<deadline:time.sleep(min(30,max(0,deadline-time.monotonic())))
if __name__=='__main__':main()
