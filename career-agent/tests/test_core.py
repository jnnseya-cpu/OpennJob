import unittest
from datetime import datetime,timezone,timedelta
from agent.core import score,gates,Store,validate_requirements
from tests.helpers import uk_rights
class Controls(unittest.TestCase):
    def profile(self):return {'confirmed':True,'email':'applicant@example.com','phone':'01234','ge_end_date':'2025-12','work_rights':uk_rights(),'evidence':[{'id':'E1','verified':True}]}
    def job(self):return {'id':'j1','country':'United Kingdom','requirements':[{'text':'Delivery','weight':80,'state':'met','evidence_ids':['E1'],'hard':False},{'text':'Licence','weight':20,'state':'unknown','evidence_ids':[],'hard':True}],'live_verified':True,'verified_at':datetime.now(timezone.utc).isoformat(),'preferences_confirmed':True}
    def test_80_does_not_override_essential(self):
        j=self.job();self.assertEqual(score(j['requirements']),80);self.assertTrue(any('Essential' in x for x in gates(j,self.profile())))
    def test_79_blocked(self):
        j=self.job();j['requirements'][0]['weight']=79;j['requirements'][1]['weight']=21;self.assertTrue(any('Below' in x for x in gates(j,self.profile())))
    def test_79_point_5_not_rounded_up(self):
        j=self.job();j['requirements'][0]['weight']=79.5;j['requirements'][1]['weight']=20.5;self.assertEqual(score(j['requirements']),79)
    def test_unknown_citation_rejected(self):
        j=self.job();j['requirements'][0]['evidence_ids']=['invented']
        with self.assertRaises(ValueError):validate_requirements(j['requirements'],self.profile())
    def test_stale_posting_blocked(self):
        j=self.job();j['verified_at']=(datetime.now(timezone.utc)-timedelta(hours=1)).isoformat();self.assertTrue(any('expired' in x for x in gates(j,self.profile())))
    def test_no_false_submitted_or_duplicate_draft(self):
        s=Store(':memory:');j=self.job();s.draft(j,{});s.transition(j['id'],'ready');s.transition(j['id'],'submitting')
        with self.assertRaises(ValueError):s.transition(j['id'],'submitted')
        s.transition(j['id'],'uncertain')
        with self.assertRaises(ValueError):s.transition(j['id'],'ready')
        with self.assertRaises(ValueError):s.draft(j,{})
    def test_international_authorisation_separate(self):
        j=self.job();j['country']='France';p=self.profile()
        self.assertTrue(any('France' in x for x in gates(j,p)))
        p['work_rights'].append(dict(uk_rights()[0],country='France'));p['relocation']=True
        self.assertFalse(any('France' in x for x in gates(j,p)))
    def test_unknown_country_not_assumed_uk(self):
        j=self.job();del j['country'];self.assertTrue(any('Unconfirmed' in x for x in gates(j,self.profile())))
    def test_seed_and_feed_deduplicate(self):
        s=Store(':memory:');s.put_job({'id':'seed','company':'AECOM','posting_id':'123'});s.put_job({'id':'feed','company':'AECOM','posting_id':'123'});self.assertEqual(len(s.jobs()),1);self.assertEqual(s.jobs()[0]['id'],'seed')
    def test_receipt_transition(self):
        s=Store(':memory:');j=self.job();s.draft(j,{});s.transition(j['id'],'ready');s.transition(j['id'],'submitting');s.transition(j['id'],'submitted',{'receipt':'ref 123','receipt_kind':'adapter_verified'});self.assertEqual(s.applications()[0]['status'],'submitted')
if __name__=='__main__':unittest.main()
