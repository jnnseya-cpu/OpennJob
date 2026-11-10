"""Scoped observation store with idempotent ingest (build spec sections 5, 6, 15, 16).

The installation is the tenancy boundary: every row carries installation_id and no
private row is ever returned before resolving installation authority. Ingest is
idempotent by the unique source-version key:
  - same key, same hash  -> duplicate (counted, not re-inserted)
  - same key, diff hash   -> conflict (409); the whole batch fails atomically
  - unregistered source / scope mismatch / PII text -> batch fails atomically

This is the in-memory reference implementation (dependency-free, used by tests and
disconnected/standalone runs). A PostgreSQL implementation with row-level security
(spec section 15) is the production adapter and mirrors this contract.
"""
from __future__ import annotations
import re
from dataclasses import dataclass
from typing import List, Optional, Tuple

from .observations import Observation
from .sources import SourceRegistry

_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_PHONE = re.compile(r"(?:(?:\+|00)\d[\d\s().-]{7,}\d|\b0\d[\d\s().-]{7,}\d)")


def _looks_like_pii(obs: Observation) -> bool:
    for text in (obs.segment, obs.metric, obs.geography, obs.locale):
        if text and (_EMAIL.search(text) or _PHONE.search(text)):
            return True
    return False


@dataclass(frozen=True)
class IngestResult:
    accepted: int
    duplicate: int


class BatchInvalid(Exception):
    """Raised when a batch is not ingestible. Carries indexed reasons (spec section 16)."""
    def __init__(self, errors: List[Tuple[int, str]]):
        self.errors = errors
        super().__init__(f"batch rejected: {errors}")


class InMemoryStore:
    def __init__(self, registry: SourceRegistry) -> None:
        self._registry = registry
        self._rows: dict[Tuple[str, str, str, int], Tuple[str, Observation]] = {}

    def ingest(self, installation_id: str, observations: List[Observation]) -> IngestResult:
        # Validate the whole batch first; any hard problem fails it atomically.
        errors: List[Tuple[int, str]] = []
        for i, o in enumerate(observations):
            if o.installation_id != installation_id:
                errors.append((i, "installation_scope_mismatch"))
            elif not self._registry.is_registered(o.source_id):
                errors.append((i, "unregistered_source"))
            elif _looks_like_pii(o):
                errors.append((i, "personally_identifiable_text_rejected"))
            else:
                existing = self._rows.get(o.key())
                if existing is not None and existing[0] != o.evidence_hash:
                    errors.append((i, "source_version_conflict"))
        if errors:
            raise BatchInvalid(errors)

        accepted = duplicate = 0
        for o in observations:
            existing = self._rows.get(o.key())
            if existing is not None and existing[0] == o.evidence_hash:
                duplicate += 1  # exact replay
            else:
                self._rows[o.key()] = (o.evidence_hash, o)
                accepted += 1
        return IngestResult(accepted=accepted, duplicate=duplicate)

    def read(self, installation_id: str, source_id: Optional[str] = None) -> List[Observation]:
        """Scoped read — only this installation's rows, never another's."""
        return [
            o for (_h, o) in self._rows.values()
            if o.installation_id == installation_id
            and (source_id is None or o.source_id == source_id)
        ]

    def get(self, installation_id: str, key: Tuple[str, str, str, int]) -> Optional[Observation]:
        """Resolve one row by key, scoped. A cross-installation key resolves to None (404)."""
        row = self._rows.get(key)
        if row is None or row[1].installation_id != installation_id:
            return None
        return row[1]

    def count(self) -> int:
        return len(self._rows)
