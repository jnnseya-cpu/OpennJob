"""Observation schema (build spec section 5).

An observation is an aggregate, scoped measurement — never free-text personal data.
`coverage = None` means unknown (a feed gap), which must never be read as zero
interest. The unique source-version key prevents replays from inflating counts.
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Optional, Tuple


@dataclass(frozen=True)
class Observation:
    installation_id: str          # the v1 tenancy boundary (spec section 15)
    source_id: str
    source_family: str
    source_record_id: str
    revision: int                 # source version; same key + new hash = conflict
    observed_at: str
    window_start: str
    window_end: str
    ingested_at: str
    metric: str
    value: float
    unit: str
    scaling_scope: str
    evidence_uri: str
    evidence_hash: str
    terms_version: str
    geography: Optional[str] = None
    locale: Optional[str] = None
    segment: Optional[str] = None
    coverage: Optional[float] = None   # None = unknown, not zero

    def key(self) -> Tuple[str, str, str, int]:
        # Unique (installation, source, source record, revision) — spec section 15.
        return (self.installation_id, self.source_id, self.source_record_id, self.revision)
