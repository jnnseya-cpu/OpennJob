"""Authenticated loopback queue for the extension. Never expose it to the internet.

  GET  /pack?job_id=   the reviewed pack, only when every gate passes
  POST /attempt        the applicant is about to submit: ready -> submitting
  POST /result         submitted (needs a receipt), uncertain or failed

The extension fills fields; the applicant answers declarations and clicks submit.
"""
import json,os,secrets
from http.server import HTTPServer,BaseHTTPRequestHandler
from urllib.parse import urlparse,parse_qs
from pathlib import Path
from .core import Store,gates,now
from .policy import daily_attempt_count
from . import paths
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def respond(self,status,payload):
        raw=json.dumps(payload).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    def authorized(self):return secrets.compare_digest(self.headers.get('Authorization','').encode(), ('Bearer '+os.environ['CAREER_AGENT_TOKEN']).encode())
    def do_GET(self):
        if not self.authorized():return self.respond(401,{'error':'Unauthorized'})
        q=urlparse(self.path)
        if q.path!='/pack':return self.respond(404,{'error':'Not found'})
        job_id=parse_qs(q.query).get('job_id',[''])[0];s=Store(paths.db_path())
        try:
            app=next(a for a in s.applications() if a['job_id']==job_id);j=next(j for j in s.jobs() if j['id']==job_id);profile=paths.read('profile.json');reasons=gates(j,profile);pack=app['payload']
            if app['status']!='ready':reasons.append('Application is not ready')
            if not pack.get('human_reviewed'):reasons.append('Pack needs review')
            if not j.get('matching_reviewed'):reasons.append('Matching needs review')
            if reasons:return self.respond(409,{'blockers':reasons})
            return self.respond(200,pack|{'gate_passed':True,'verified_at':j['verified_at']})
        except StopIteration:return self.respond(404,{'error':'Application not found'})
        finally:s.db.close()
    def do_POST(self):
        if not self.authorized():return self.respond(401,{'error':'Unauthorized'})
        if self.headers.get('Content-Type')!='application/json':return self.respond(415,{'error':'JSON required'})
        length=int(self.headers.get('Content-Length',0))
        if length>100000:return self.respond(413,{'error':'Too large'})
        s=Store(paths.db_path())
        try:
            body=json.loads(self.rfile.read(length));job_id=body['job_id']
            if self.path=='/attempt':
                j=next(j for j in s.jobs() if j['id']==job_id);profile=paths.read('profile.json');reasons=gates(j,profile);a=next(a for a in s.applications() if a['job_id']==job_id)
                if not a['payload'].get('human_reviewed'):reasons.append('Pack needs review')
                if not j.get('matching_reviewed'):reasons.append('Matching needs review')
                if daily_attempt_count(s)>=paths.read('policy.json')['daily_submission_limit']:reasons.append('Daily attempt limit reached')
                if reasons:return self.respond(409,{'blockers':reasons})
                s.transition(job_id,'submitting',{'attempt_at':now(),'initiated_by':'applicant'});return self.respond(200,{'ok':True})
            if self.path=='/result':
                status=body.get('status')
                if status not in ('submitted','uncertain','failed'):raise ValueError('Invalid result')
                receipt=str(body.get('receipt',''))[:1600]
                s.transition(job_id,status,{'receipt':receipt,'receipt_kind':'adapter_verified' if status=='submitted' else None});return self.respond(200,{'ok':True})
            return self.respond(404,{'error':'Not found'})
        except (ValueError,KeyError,StopIteration) as e:return self.respond(409,{'error':str(e)})
        finally:s.db.close()
def make_server(port=8765):
    if len(os.getenv('CAREER_AGENT_TOKEN',''))<24:raise SystemExit('Set CAREER_AGENT_TOKEN to a random value of at least 24 characters')
    return HTTPServer(('127.0.0.1',port),Handler)
def main():
    server=make_server(int(os.getenv('CAREER_AGENT_PORT','8765')))
    print(f'Local queue: http://127.0.0.1:{server.server_port}; authenticated requests only');server.serve_forever()
if __name__=='__main__':main()
