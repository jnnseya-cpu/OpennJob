"""Growth Brief v1 validation (build spec section 6 and Appendix A).

A schema-valid brief can still fail the runtime rules, so both are checked.
No personal data: a brief carries ids, scopes and approved-claim references only.
"""
from __future__ import annotations
import re
from datetime import datetime, timezone
from typing import Any

ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
MARKET_RE = re.compile(r"^[A-Z]{2}$")
UTC_RE = re.compile(r"Z$")

ALLOWED_CHANNELS = {"seo", "organic_social", "sales_enablement",
                    "owned_placement", "lifecycle", "paid"}
# v1 only ships draft routes for these; the rest reserve routing values only.
V1_ENABLED_CHANNELS = {"seo", "organic_social"}

REQUIRED = [
    "schema_version", "brief_id", "brief_version", "tenant_id", "platform_id",
    "market", "locale", "topic_id", "opportunity_score", "confidence",
    "valid_from", "expires_at", "evidence_ids", "audience", "intent",
    "approved_claim_ids", "cta_id", "allowed_channels", "prohibited_claims",
    "objective", "experiment_id", "policy_version",
]
ALLOWED_KEYS = set(REQUIRED)


def _is_id(v: Any) -> bool:
    return isinstance(v, str) and bool(ID_RE.match(v))


def _parse_utc(v: Any) -> datetime | None:
    if not isinstance(v, str) or not UTC_RE.search(v):
        return None
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None


def validate_brief(brief: dict, *, now: datetime | None = None) -> list[str]:
    """Return a list of problems. Empty list means the brief is valid and live.

    Covers the closed-object schema (Appendix A) plus the runtime rules
    (section 6 / Appendix A 'Runtime rules'): valid_from < expires_at and
    valid_from <= now < expires_at.
    """
    errors: list[str] = []
    if not isinstance(brief, dict):
        return ["brief must be an object"]

    extra = set(brief) - ALLOWED_KEYS
    if extra:
        errors.append(f"unexpected fields (closed object): {sorted(extra)}")
    for key in REQUIRED:
        if key not in brief:
            errors.append(f"missing required field: {key}")
    if errors:
        return errors  # don't type-check fields that may be absent

    if brief["schema_version"] != 1:
        errors.append("schema_version must be 1")
    for key in ("brief_id", "tenant_id", "platform_id", "topic_id", "cta_id",
                "experiment_id"):
        if not _is_id(brief[key]):
            errors.append(f"{key} is not a valid id")
    for key in ("brief_version", "policy_version"):
        if not isinstance(brief[key], int) or brief[key] < 1:
            errors.append(f"{key} must be an integer >= 1")
    for key in ("opportunity_score", "confidence"):
        v = brief[key]
        if not isinstance(v, (int, float)) or isinstance(v, bool) or not (0 <= v <= 100):
            errors.append(f"{key} must be a number in 0..100")
    if not MARKET_RE.match(str(brief["market"])):
        errors.append("market must match ^[A-Z]{2}$ (ISO alpha-2; ZZ = global)")
    if not isinstance(brief["locale"], str) or not (2 <= len(brief["locale"]) <= 35):
        errors.append("locale length must be 2..35")
    for key in ("audience", "intent", "objective"):
        v = brief[key]
        if not isinstance(v, str) or not (1 <= len(v) <= 500):
            errors.append(f"{key} must be short text 1..500 chars")

    ev = brief["evidence_ids"]
    if not isinstance(ev, list) or not (1 <= len(ev) <= 64) or len(set(ev)) != len(ev) \
            or not all(_is_id(x) for x in ev):
        errors.append("evidence_ids must be 1..64 unique ids")
    ac = brief["approved_claim_ids"]
    if not isinstance(ac, list) or len(ac) > 64 or len(set(ac)) != len(ac) \
            or not all(_is_id(x) for x in ac):
        errors.append("approved_claim_ids must be up to 64 unique ids")

    ch = brief["allowed_channels"]
    if not isinstance(ch, list) or not (1 <= len(ch) <= 6) or len(set(ch)) != len(ch):
        errors.append("allowed_channels must be 1..6 unique values")
    elif not set(ch) <= ALLOWED_CHANNELS:
        errors.append(f"allowed_channels has unknown values: {sorted(set(ch) - ALLOWED_CHANNELS)}")

    pc = brief["prohibited_claims"]
    if not isinstance(pc, list) or len(pc) > 32 or len(set(pc)) != len(pc) \
            or not all(isinstance(x, str) and 1 <= len(x) <= 500 for x in pc):
        errors.append("prohibited_claims must be up to 32 unique short strings")

    vf = _parse_utc(brief["valid_from"])
    ex = _parse_utc(brief["expires_at"])
    if vf is None:
        errors.append("valid_from must be an RFC3339 UTC time ending in Z")
    if ex is None:
        errors.append("expires_at must be an RFC3339 UTC time ending in Z")
    if vf and ex:
        if not (vf < ex):
            errors.append("valid_from must be before expires_at")
        else:
            current = now or datetime.now(timezone.utc)
            if not (vf <= current < ex):
                errors.append("brief is not currently live (need valid_from <= now < expires_at)")
    return errors
