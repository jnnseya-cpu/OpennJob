"""Deterministic-core tests. Pin the spec's worked example and conformance rows
(TI-01/03/04) so the numbers can never silently drift. No external calls."""
import os
import sys
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import scoring as S
from engine import brief as B


def fixture_brief():
    # The section 6 Growth Brief fixture (synthetic).
    return {
        "schema_version": 1, "brief_id": "gb_104", "brief_version": 3,
        "tenant_id": "tenant_demo", "platform_id": "fixture_platform_a",
        "market": "CA", "locale": "en-CA", "topic_id": "simpler-team-onboarding",
        "opportunity_score": 86.25, "confidence": 83.5,
        "valid_from": "2026-11-10T10:00:00Z", "expires_at": "2026-11-17T10:00:00Z",
        "evidence_ids": ["ev_341", "ev_342"],
        "audience": "Small teams comparing onboarding options",
        "intent": "evaluate how to onboard a small team",
        "approved_claim_ids": ["claim_onboarding_01"],
        "cta_id": "cta_view_onboarding_guide",
        "allowed_channels": ["seo", "organic_social"],
        "prohibited_claims": ["guaranteed onboarding time",
                              "unsupported third-party endorsements"],
        "objective": "qualified trial starts per eligible session",
        "experiment_id": "exp_91", "policy_version": 5,
    }


INSIDE = datetime(2026, 11, 12, tzinfo=timezone.utc)


class Scoring(unittest.TestCase):
    def test_opportunity_example(self):
        # demand 80, fit 95, intent 85, timing 90, readiness 80 -> 86.25
        self.assertAlmostEqual(S.opportunity_score(80, 95, 85, 90, 80), 86.25, places=6)

    def test_confidence_example(self):
        # source 90, corroboration 80, coverage 70, freshness 90 -> 83.5
        self.assertAlmostEqual(S.confidence(90, 80, 70, 90), 83.5, places=6)

    def test_TI03_reviewable_not_rounded(self):
        score = S.opportunity_score(80, 95, 85, 90, 80)
        conf = S.confidence(90, 80, 70, 90)
        self.assertEqual(S.decision(score, conf), S.REVIEWABLE_BRIEF)
        # not rounded before the decision
        self.assertNotEqual(score, round(score))

    def test_gating_bands(self):
        self.assertEqual(S.decision(59, 90), S.ARCHIVE)
        self.assertEqual(S.decision(90, 54), S.ARCHIVE)
        self.assertEqual(S.decision(70, 60), S.WATCH)
        self.assertEqual(S.decision(80, 80), S.REVIEWABLE_BRIEF)
        self.assertEqual(S.decision(90, 90, tenant_opt_in=True), S.AUTO_ELIGIBLE)
        self.assertEqual(S.decision(90, 90, tenant_opt_in=False), S.REVIEWABLE_BRIEF)

    def test_veto_cannot_exceed_watch(self):
        self.assertEqual(S.decision(95, 95, veto=True, tenant_opt_in=True), S.WATCH)

    def test_corroboration_values(self):
        self.assertEqual(S.corroboration_value(1), 0)
        self.assertEqual(S.corroboration_value(2), 80)
        self.assertEqual(S.corroboration_value(5), 100)

    def test_TI04_single_family_capped(self):
        # Three syndications of one story = one source family -> capped at 69,
        # so confidence can never reach the 75 needed to activate.
        corr = S.corroboration_value(1)
        conf = S.confidence(100, corr, 100, 100, single_source_family=True)
        self.assertLessEqual(conf, S.SINGLE_FAMILY_CAP)
        self.assertEqual(S.decision(95, conf), S.WATCH)

    def test_lift_and_z_and_gate(self):
        self.assertAlmostEqual(S.lift(0, 0), 0.0, places=9)
        hist = [10, 11, 9, 12, 10, 8, 11, 10]
        z = S.anomaly_z(40, hist)
        self.assertGreater(z, 2.0)
        self.assertTrue(S.count_feed_gate(40, z, comparable_periods=8))
        # insufficient history stays draft-only even with a big spike
        self.assertFalse(S.count_feed_gate(40, z, comparable_periods=3))

    def test_demand_from_z_clamped(self):
        self.assertEqual(S.demand_from_z(0), 50)
        self.assertEqual(S.demand_from_z(10), 100)   # clamp high
        self.assertEqual(S.demand_from_z(-10), 0)    # clamp low


class Brief(unittest.TestCase):
    def test_TI_fixture_valid_when_live(self):
        self.assertEqual(B.validate_brief(fixture_brief(), now=INSIDE), [])

    def test_rejects_extra_field(self):
        b = fixture_brief(); b["isAdmin"] = True
        errs = B.validate_brief(b, now=INSIDE)
        self.assertTrue(any("unexpected" in e for e in errs))

    def test_rejects_unknown_channel(self):
        b = fixture_brief(); b["allowed_channels"] = ["seo", "telepathy"]
        errs = B.validate_brief(b, now=INSIDE)
        self.assertTrue(any("allowed_channels" in e for e in errs))

    def test_rejects_expired_or_premature(self):
        after = datetime(2026, 11, 20, tzinfo=timezone.utc)
        self.assertTrue(B.validate_brief(fixture_brief(), now=after))
        before = datetime(2026, 11, 1, tzinfo=timezone.utc)
        self.assertTrue(B.validate_brief(fixture_brief(), now=before))

    def test_rejects_bad_window_order(self):
        b = fixture_brief(); b["valid_from"], b["expires_at"] = b["expires_at"], b["valid_from"]
        errs = B.validate_brief(b, now=INSIDE)
        self.assertTrue(any("before expires_at" in e for e in errs))

    def test_rejects_missing_required(self):
        b = fixture_brief(); del b["market"]
        errs = B.validate_brief(b, now=INSIDE)
        self.assertTrue(any("market" in e for e in errs))


if __name__ == "__main__":
    unittest.main()
