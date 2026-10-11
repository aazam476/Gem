"""The deterministic gateway: pure, AI-free validation of extracted vitals.

Everything in this module is side-effect free so it can be unit-tested exhaustively
and timed in isolation (perf_counter_ns around ``evaluate``). Rules are compiled
once per protocol and cached in memory by the store, so no I/O happens here.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

from .rules import ValidationRules

Outcome = Literal["accepted", "flagged", "rejected"]


@dataclass(frozen=True, slots=True)
class CompiledMetric:
    name: str
    min: float
    max: float
    hard_min: float
    hard_max: float
    required: bool


@dataclass(frozen=True, slots=True)
class CompiledRules:
    metrics: tuple[CompiledMetric, ...]
    known: frozenset[str]
    greater_than: tuple[tuple[str, str], ...]


@dataclass(frozen=True, slots=True)
class Issue:
    code: str
    metric: str | None
    message: str

    def as_dict(self) -> dict[str, str | None]:
        return {"code": self.code, "metric": self.metric, "message": self.message}


@dataclass(frozen=True, slots=True)
class Verdict:
    outcome: Outcome
    values: dict[str, float]
    errors: tuple[Issue, ...]
    flags: tuple[Issue, ...]


def compile_rules(rules: ValidationRules) -> CompiledRules:
    metrics = tuple(
        CompiledMetric(m.name, m.min, m.max, m.hard_min, m.hard_max, m.required)
        for m in rules.metrics
    )
    return CompiledRules(
        metrics=metrics,
        known=frozenset(m.name for m in metrics),
        greater_than=tuple((r.left, r.right) for r in rules.cross_field),
    )


def _is_number(value: object) -> bool:
    # bool is an int subclass; a hallucinated `true` must not pass as 1.
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def evaluate(rules: CompiledRules, readings: object) -> Verdict:
    """Validate one set of readings against compiled rules.

    Invariants:
    - Implausible, missing-required, non-numeric or unknown values => ``rejected``.
    - Cross-field violations (e.g. systolic <= diastolic) => ``rejected``.
    - Plausible but outside the expected range => ``flagged`` (still stored).
    - Otherwise ``accepted``.
    """
    if not isinstance(readings, Mapping):
        return Verdict("rejected", {}, (Issue("malformed", None, "readings must be an object"),), ())

    errors: list[Issue] = []
    flags: list[Issue] = []
    values: dict[str, float] = {}

    for key in readings:
        if key not in rules.known:
            errors.append(Issue("unexpected_metric", str(key), f"'{key}' is not part of this protocol"))

    for m in rules.metrics:
        raw = readings.get(m.name)
        if raw is None:
            if m.required:
                errors.append(Issue("missing_metric", m.name, f"{m.name} is required"))
            continue
        if not _is_number(raw):
            errors.append(Issue("not_a_number", m.name, f"{m.name} must be a finite number"))
            continue
        value = float(raw)
        if value < m.hard_min or value > m.hard_max:
            errors.append(Issue(
                "implausible", m.name,
                f"{m.name}={value:g} is outside plausible limits [{m.hard_min:g}, {m.hard_max:g}]",
            ))
            continue
        values[m.name] = value
        if value < m.min:
            flags.append(Issue("below_range", m.name, f"{m.name}={value:g} is below {m.min:g}"))
        elif value > m.max:
            flags.append(Issue("above_range", m.name, f"{m.name}={value:g} is above {m.max:g}"))

    for left, right in rules.greater_than:
        if left in values and right in values and not values[left] > values[right]:
            errors.append(Issue(
                "cross_field", left,
                f"{left} ({values[left]:g}) must be greater than {right} ({values[right]:g})",
            ))

    if errors:
        return Verdict("rejected", values, tuple(errors), tuple(flags))
    return Verdict("flagged" if flags else "accepted", values, (), tuple(flags))
