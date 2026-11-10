"""Foundation stage tests (spec G1 + conformance TI-01/TI-02):
idempotent scoped ingest, source-version replay/conflict, tenant isolation,
unknown-not-zero, stale sources cannot support fresh actions."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.sources import Source, SourceRegistry
from engine.observations import Observation
from engine.store import InMemoryStore, IngestResult, BatchInvalid


def registry():
    r = SourceRegistry()
    r.register(Source(source_id="fp_search", family="first_party",
                      access_path="public_keyless", owner="tenant", terms="owned"))
    return r


def obs(installation="inst_a", rev=1, value=42.0, h="hash1", source="fp_search",
        record="rec1", coverage=None, segment=None):
    return Observation(
        installation_id=installation, source_id=source, source_family="first_party",
        source_record_id=record, revision=rev,
        observed_at="2026-11-10T10:00:00Z", window_start="2026-11-10T09:00:00Z",
        window_end="2026-11-10T10:00:00Z", ingested_at="2026-11-10T10:05:00Z",
        metric="internal_search", value=value, unit="count", scaling_scope="native",
        evidence_uri="s3://ev/1", evidence_hash=h, terms_version="v1",
        coverage=coverage, segment=segment)


class Ingest(unittest.TestCase):
    def test_TI01_replay_and_conflict(self):
        store = InMemoryStore(registry())
        r1 = store.ingest("inst_a", [obs()])
        self.assertEqual(r1, IngestResult(accepted=1, duplicate=0))
        # exact replay -> duplicate, persists once
        r2 = store.ingest("inst_a", [obs()])
        self.assertEqual(r2, IngestResult(accepted=0, duplicate=1))
        self.assertEqual(store.count(), 1)
        # same source version key, changed hash -> conflict, batch fails atomically
        with self.assertRaises(BatchInvalid) as ctx:
            store.ingest("inst_a", [obs(h="hash2", value=99.0)])
        self.assertTrue(any(code == "source_version_conflict" for _i, code in ctx.exception.errors))
        self.assertEqual(store.count(), 1)  # unchanged

    def test_new_revision_is_accepted(self):
        store = InMemoryStore(registry())
        store.ingest("inst_a", [obs(rev=1, h="h1")])
        r = store.ingest("inst_a", [obs(rev=2, h="h2")])  # new version, not a conflict
        self.assertEqual(r.accepted, 1)
        self.assertEqual(store.count(), 2)

    def test_atomic_reject_on_unregistered_source(self):
        store = InMemoryStore(registry())
        batch = [obs(record="ok"), obs(record="bad", source="not_registered")]
        with self.assertRaises(BatchInvalid):
            store.ingest("inst_a", batch)
        self.assertEqual(store.count(), 0)  # nothing from the batch persisted

    def test_rejects_pii_text(self):
        store = InMemoryStore(registry())
        with self.assertRaises(BatchInvalid) as ctx:
            store.ingest("inst_a", [obs(segment="user jane@example.org")])
        self.assertTrue(any("personally_identifiable" in code for _i, code in ctx.exception.errors))

    def test_unknown_coverage_is_not_zero(self):
        store = InMemoryStore(registry())
        store.ingest("inst_a", [obs(coverage=None)])
        got = store.read("inst_a")[0]
        self.assertIsNone(got.coverage)   # unknown stays unknown, never coerced to 0


class Isolation(unittest.TestCase):
    def test_TI02_cross_installation_sees_nothing(self):
        store = InMemoryStore(registry())
        store.ingest("inst_a", [obs(installation="inst_a")])
        # installation B reads nothing of A's
        self.assertEqual(store.read("inst_b"), [])
        # a cross-scope key resolves to None (404)
        key = obs(installation="inst_a").key()
        self.assertIsNone(store.get("inst_b", key))
        self.assertIsNotNone(store.get("inst_a", key))

    def test_scope_mismatch_in_batch_is_rejected(self):
        store = InMemoryStore(registry())
        with self.assertRaises(BatchInvalid):
            store.ingest("inst_a", [obs(installation="inst_b")])  # caller scope != row scope
        self.assertEqual(store.count(), 0)


class Registry(unittest.TestCase):
    def test_stale_source_cannot_action(self):
        active = Source("s1", "f", "public_keyless", "o", "t", status="active")
        stale = Source("s2", "f", "public_keyless", "o", "t", status="stale")
        self.assertTrue(active.can_support_fresh_action())
        self.assertFalse(stale.can_support_fresh_action())

    def test_bad_access_path_rejected(self):
        r = SourceRegistry()
        with self.assertRaises(ValueError):
            r.register(Source("s", "f", "secret_backchannel", "o", "t"))


if __name__ == "__main__":
    unittest.main()
