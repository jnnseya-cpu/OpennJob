"""Read-only employer feeds. Each needs a known company board identifier."""
import json,urllib.request,urllib.parse,re,time
from .core import canonical_id,now

def get(url,headers=None):
    req=urllib.request.Request(url,headers={'Accept':'application/json','User-Agent':'NseyaCareerAgent/0.1'}| (headers or {}))
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req,timeout=25) as r:return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code not in (429,502,503,504) or attempt==2:raise
            time.sleep(min(int(e.headers.get('Retry-After','2')) if e.headers.get('Retry-After','2').isdigit() else 2,10)*(attempt+1))
def plain(s):return re.sub('<[^>]+>',' ',s or '').strip()
def normal(company,source,pid,title,location,url,description,**extra):
    if not url.startswith('https://'):raise ValueError('HTTPS employer URL required')
    return {'id':canonical_id(company,url,pid),'posting_id':str(pid),'company':company,'source':source,'title':title,'location':location,'url':url,'description':plain(description),'fetched_at':now(),'live_verified':False,'requirements':[],'status':'discovered','country':'Unconfirmed'}|extra

def fetch(board,start=0,meta=None):
    """All postings of one board. meta (a dict) receives pages, truncated and the next cursor: a
    source capped by max_details resumes from the cursor next cycle, so no page is starved (T07)."""
    company=board['company'];name=urllib.parse.quote(board['board'],safe='');kind=board['type'];out=[]
    meta=meta if meta is not None else {}
    meta.update(pages=0,truncated=False,next=0)
    if kind=='greenhouse':
        a=get(f'https://boards-api.greenhouse.io/v1/boards/{name}/jobs?content=true')['jobs'];meta['pages']=1
        out=[normal(company,kind,j['id'],j['title'],j['location']['name'],j['absolute_url'],j.get('content',''),jd_url=j['absolute_url']) for j in a]
    elif kind=='lever':
        domain='api.eu.lever.co' if board.get('region')=='eu' else 'api.lever.co';skip=0
        while True:
            a=get(f'https://{domain}/v0/postings/{name}?mode=json&skip={skip}&limit=100');meta['pages']+=1
            for j in a:
                desc=j.get('descriptionPlain','')+' '+ ' '.join(x.get('text','')+' '+plain(x.get('content','')) for x in j.get('lists',[]))+' '+j.get('additionalPlain','')
                out.append(normal(company,kind,j['id'],j['text'],j.get('categories',{}).get('location',''),j['applyUrl'],desc,jd_url=j.get('hostedUrl') or j['applyUrl'],work_type=j.get('categories',{}).get('commitment','Unconfirmed')))
            if len(a)<100:break
            skip+=100
            if skip>10000:raise RuntimeError('Pagination safety limit reached')
    elif kind=='ashby':
        a=get(f'https://api.ashbyhq.com/posting-api/job-board/{name}?includeCompensation=true')['jobs'];meta['pages']=1
        out=[normal(company,kind,j['jobUrl'],j['title'],j.get('location',''),j['applyUrl'],j.get('descriptionPlain',''),salary=j.get('compensation',{}),jd_url=j['jobUrl'] if str(j.get('jobUrl','')).startswith('https://') else j['applyUrl'],work_type=j.get('employmentType','Unconfirmed')) for j in a if j.get('isListed',True)]
    elif kind=='smartrecruiters':
        origin=offset=int(start or 0);limit=board.get('max_details',100);wrapped=False
        while True:
            query=urllib.parse.urlencode({'q':board.get('query',''),'limit':100,'offset':offset,'destination':'PUBLIC'})
            a=get(f'https://api.smartrecruiters.com/v1/companies/{name}/postings?'+query);meta['pages']+=1
            content=a.get('content',[])
            for item in content:
                terms=board.get('title_keywords',['construction','project manager','programme','program manager','epc','subcontract','delivery','site manager','package manager'])
                if terms and not any(t.lower() in item.get('name','').lower() for t in terms):continue
                pid=urllib.parse.quote(str(item['id']),safe='')
                j=get(f'https://api.smartrecruiters.com/v1/companies/{name}/postings/{pid}')
                sections=j.get('jobAd',{}).get('sections',{})
                desc=' '.join(v.get('text','') for v in sections.values() if isinstance(v,dict))
                loc=j.get('location',{});url=j.get('applyUrl') or item.get('applyUrl') or j.get('postingUrl')
                if not url:continue
                out.append(normal(company,kind,item['id'],j.get('name',item.get('name','')),loc.get('city',''),url,desc,jd_url=j.get('postingUrl') if str(j.get('postingUrl','')).startswith('https://') else url,country_code=loc.get('country',''),country={'gb':'United Kingdom','uk':'United Kingdom','ie':'Ireland','fr':'France','de':'Germany','ae':'United Arab Emirates','sa':'Saudi Arabia','cd':'Democratic Republic of the Congo','us':'United States','ca':'Canada','au':'Australia'}.get(str(loc.get('country','')).lower(),'Unconfirmed'),description_full=True,employment_type=j.get('typeOfEmployment',{}).get('label','Unconfirmed'),work_type=j.get('typeOfEmployment',{}).get('id','Unconfirmed')))
                if len(out)>=limit:break
            if len(out)>=limit:
                meta.update(truncated=True,next=offset+content.index(item)+1);break
            offset+=len(content)
            if wrapped and offset>=origin:break  # back where this cycle started: everything was read once
            if not content or offset>=int(a.get('totalFound',offset)):
                # Reached the end: wrap once to cover what came before the cursor, then stop.
                if origin and not wrapped and len(out)<limit:offset=0;wrapped=True;continue
                break
            if offset>10000:raise RuntimeError('Pagination safety limit reached')
    else:raise ValueError('Unsupported public feed: '+kind)
    return out

def reed(keywords,location='Birmingham',skip=0):
    import os,base64
    key=os.getenv('REED_API_KEY')
    if not key:raise RuntimeError('REED_API_KEY required')
    headers={'Authorization':'Basic '+base64.b64encode((key+':').encode()).decode()}
    q=urllib.parse.urlencode({'keywords':keywords,'locationName':location,'resultsToTake':100,'resultsToSkip':skip})
    a=get('https://www.reed.co.uk/api/1.0/search?'+q,headers);out=[]
    for j in a:
        detail=get('https://www.reed.co.uk/api/1.0/jobs/'+str(j['jobId']),headers)
        out.append(normal(j['employerName'],'reed',j['jobId'],j['jobTitle'],j['locationName'],detail.get('externalUrl') or j['jobUrl'],detail.get('jobDescription',''),salary_min=detail.get('yearlyMinimumSalary'),salary_max=detail.get('yearlyMaximumSalary'),country='United Kingdom'))
    return out

def adzuna(keywords,country='gb',page=1):
    import os
    app_id=os.getenv('ADZUNA_APP_ID');key=os.getenv('ADZUNA_APP_KEY')
    if not app_id or not key:raise RuntimeError('ADZUNA_APP_ID and ADZUNA_APP_KEY required')
    q=urllib.parse.urlencode({'app_id':app_id,'app_key':key,'what':keywords,'results_per_page':50,'content-type':'application/json'})
    a=get(f'https://api.adzuna.com/v1/api/jobs/{urllib.parse.quote(country,safe="")}/search/{int(page)}?'+q)['results']
    return [normal(j.get('company',{}).get('display_name','Unknown employer'),'adzuna',j['id'],j['title'],j.get('location',{}).get('display_name',''),j['redirect_url'],j.get('description',''),description_complete=False,salary_min=j.get('salary_min'),salary_max=j.get('salary_max')) for j in a]
