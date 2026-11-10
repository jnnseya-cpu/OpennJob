"""Deterministic detection & scoring core for the Trend Intelligence engine.

Pure functions only: no I/O, no external calls, no personal data. These implement
the formulas and thresholds fixed in the build spec (sections 5 and 17) so the
numbers are reproducible and auditable. The optional AI/inference layers sit on
top of this; this core must work with the model absent (deterministic mode).
"""
from __future__ import annotations
import math
from statistics import median
from typing import Sequence

# ---- movement: log lift and robust anomaly z (spec section 5.3) ---------------

def log1p(x: float) -> float:
    return math.log1p(x)


def lift(current: float, baseline: float) -> float:
    """lift = ln((c+1)/(b+1))."""
    return math.log((current + 1.0) / (baseline + 1.0))


def _mad(values: Sequence[float]) -> float:
    """Median absolute deviation."""
    m = median(values)
    return median([abs(v - m) for v in values])


def anomaly_z(current: float, history: Sequence[float]) -> float:
    """z = (log1p(c) - median(log1p(x))) / max(1.4826 * MAD(log1p(x)), 0.2)."""
    logs = [log1p(x) for x in history]
    med = median(logs)
    scale = max(1.4826 * _mad(logs), 0.2)
    return (log1p(current) - med) / scale


# Initial count-feed gate (adjustable by source/geography).
COUNT_GATE_MIN = 20
Z_GATE_MIN = 2.0
MIN_COMPARABLE_PERIODS = 4


def count_feed_gate(current: float, z: float, comparable_periods: int) -> bool:
    """True when a count feed clears the volume+anomaly gate with enough history."""
    if comparable_periods < MIN_COMPARABLE_PERIODS:
        return False  # insufficient history -> draft-only, not an action
    return current >= COUNT_GATE_MIN and z >= Z_GATE_MIN


def demand_from_z(z: float) -> float:
    """Reference count-feed demand mapping: clamp(50 + 10*z, 0, 100) (spec 17)."""
    return max(0.0, min(100.0, 50.0 + 10.0 * z))


# ---- opportunity score (spec 5.4): 25/25/20/15/15 ----------------------------

def opportunity_score(demand: float, fit: float, intent: float,
                      timing: float, readiness: float) -> float:
    return (0.25 * demand + 0.25 * fit + 0.20 * intent
            + 0.15 * timing + 0.15 * readiness)


# ---- confidence (spec 5.5): 35/25/20/20, single-family cap 69 -----------------

SINGLE_FAMILY_CAP = 69.0


def corroboration_value(independent_family_count: int) -> float:
    """0 for one family, 80 for two, 100 for three or more (spec 17)."""
    if independent_family_count >= 3:
        return 100.0
    if independent_family_count == 2:
        return 80.0
    return 0.0


def confidence(source_quality: float, corroboration: float, coverage: float,
               freshness: float, *, single_source_family: bool = False) -> float:
    value = (0.35 * source_quality + 0.25 * corroboration
             + 0.20 * coverage + 0.20 * freshness)
    if single_source_family:
        return min(value, SINGLE_FAMILY_CAP)
    return value


# ---- decision gating (spec 5 table). Full precision; never round before deciding.

ARCHIVE = "archive"
WATCH = "watch"
REVIEWABLE_BRIEF = "reviewable_brief"
AUTO_ELIGIBLE = "auto_eligible"


def decision(score: float, conf: float, *, veto: bool = False,
             tenant_opt_in: bool = False) -> str:
    """Map (opportunity score, confidence) to a lifecycle result.

    Below archive cutoffs -> archive. A hard veto can never exceed watch.
    >=75/>=75 -> reviewable brief. >=85/>=85 with explicit opt-in -> auto eligible
    (bounded, low-risk classes only; external actions still need policy approval).
    """
    if score < 60 or conf < 55:
        return ARCHIVE
    if not veto:
        if score >= 85 and conf >= 85 and tenant_opt_in:
            return AUTO_ELIGIBLE
        if score >= 75 and conf >= 75:
            return REVIEWABLE_BRIEF
    return WATCH
