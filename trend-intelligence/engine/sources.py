"""Source registry (build spec section 3).

Every source adapter registers what it is and what it may prove. A source not in
the registry cannot be ingested. A stale or failed source gives dated context only
and cannot support fresh automated actions. A feed gap is unknown data, never zero.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Tuple

ACCESS_PATHS = {"public_keyless", "host_mediated", "file_import"}
STATUSES = {"active", "stale", "failed"}


@dataclass(frozen=True)
class Source:
    source_id: str
    family: str                       # e.g. first_party, search_console, trends, procurement
    access_path: str                  # public_keyless | host_mediated | file_import
    owner: str
    terms: str
    territories: Tuple[str, ...] = ()
    languages: Tuple[str, ...] = ()
    cadence: str = ""
    ingestion_lag: str = ""
    quota: str = ""
    retention: str = ""
    status: str = "active"            # active | stale | failed

    def can_support_fresh_action(self) -> bool:
        return self.status == "active"


class SourceRegistry:
    def __init__(self) -> None:
        self._sources: dict[str, Source] = {}

    def register(self, source: Source) -> None:
        if source.access_path not in ACCESS_PATHS:
            raise ValueError(f"unknown access_path: {source.access_path!r}")
        if source.status not in STATUSES:
            raise ValueError(f"unknown status: {source.status!r}")
        self._sources[source.source_id] = source

    def get(self, source_id: str) -> Source | None:
        return self._sources.get(source_id)

    def is_registered(self, source_id: str) -> bool:
        return source_id in self._sources
