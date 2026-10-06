"""One local command supervises discovery, the browser assistant and 09:00 reports.

--submit runs the worker in assist mode: it fills each ready application and waits for you
to answer the declarations and click submit. Without it the worker only does dry runs.
"""
import argparse,os,subprocess,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def main():
    p=argparse.ArgumentParser();p.add_argument('--submit',action='store_true');p.add_argument('--no-email',action='store_true');p.add_argument('--max-matches',type=int,default=10);a=p.parse_args()
    if a.submit and os.getenv('CAREER_HEADLESS','false').lower()=='true':raise SystemExit('--submit needs a visible browser: you click submit yourself. Unset CAREER_HEADLESS.')
    commands=[[sys.executable,'-m','agent.discovery','--max-matches',str(a.max_matches)],[sys.executable,'-m','agent.worker']+(['--submit'] if a.submit else [])]
    if not a.no_email:
        needed=['SMTP_HOST','SMTP_USERNAME','SMTP_PASSWORD','SMTP_FROM','REPORT_TO']
        if any(not os.getenv(k) for k in needed):raise SystemExit('Configure SMTP for 09:00 reports, or explicitly use --no-email during setup.')
        commands.append([sys.executable,'-m','agent.cli','schedule'])
    children=[]
    try:
        children=[subprocess.Popen(c,cwd=ROOT) for c in commands]
        print('Local trial running. Computer must stay awake and connected. Ctrl+C stops all components.',flush=True)
        while True:
            if any(c.poll() is not None for c in children):raise RuntimeError('A component stopped; inspect its error and restart after reconciliation.')
            time.sleep(2)
    except KeyboardInterrupt:pass
    finally:
        for c in children:
            if c.poll() is None:c.terminate()
        for c in children:
            try:c.wait(timeout=5)
            except subprocess.TimeoutExpired:c.kill();c.wait()
if __name__=='__main__':main()
