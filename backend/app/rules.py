"""Validation-rule schema authored by researchers in the portal.

Two tiers per metric:
- ``hard_min``/``hard_max``: physiologically plausible limits. Outside them the
  value is treated as an AI misread/hallucination and REJECTED (never stored as data).
- ``min``/``max``: the protocol's expected range. Outside it (but still plausible)
  the value is STORED and FLAGGED for the study team, because a genuine 210 mmHg
  reading is clinically important and must not be thrown away as a "retake".
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

METRIC_NAME_PATTERN = r"^[a-z][a-z0-9_]{0,31}$"


class MetricRule(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(pattern=METRIC_NAME_PATTERN, description="Machine key, e.g. 'systolic'")
    label: str = Field(default="", max_length=64, description="Spoken/display name")
    unit: str = Field(default="", max_length=16)
    min: float
    max: float
    hard_min: float
    hard_max: float
    required: bool = True

    @model_validator(mode="after")
    def _ordered(self) -> MetricRule:
        if not (self.hard_min <= self.min <= self.max <= self.hard_max):
            raise ValueError(
                f"metric '{self.name}': expected hard_min <= min <= max <= hard_max"
            )
        return self

    @property
    def display_name(self) -> str:
        return self.label or self.name.replace("_", " ")


class CrossFieldRule(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["greater_than"] = "greater_than"
    left: str = Field(pattern=METRIC_NAME_PATTERN)
    right: str = Field(pattern=METRIC_NAME_PATTERN)


class ValidationRules(BaseModel):
    model_config = ConfigDict(extra="forbid")

    metrics: list[MetricRule] = Field(min_length=1, max_length=12)
    cross_field: list[CrossFieldRule] = Field(default_factory=list, max_length=12)

    @model_validator(mode="after")
    def _consistent(self) -> ValidationRules:
        names = [m.name for m in self.metrics]
        if len(names) != len(set(names)):
            raise ValueError("metric names must be unique")
        for rule in self.cross_field:
            for ref in (rule.left, rule.right):
                if ref not in names:
                    raise ValueError(f"cross_field rule references unknown metric '{ref}'")
            if rule.left == rule.right:
                raise ValueError("cross_field rule must compare two different metrics")
        return self


def blood_pressure_preset() -> ValidationRules:
    """Default rules for an upper-arm BP monitor (systolic/diastolic/pulse)."""
    return ValidationRules(
        metrics=[
            MetricRule(name="systolic", label="systolic", unit="mmHg",
                       min=90, max=180, hard_min=50, hard_max=260),
            MetricRule(name="diastolic", label="diastolic", unit="mmHg",
                       min=50, max=110, hard_min=30, hard_max=160),
            MetricRule(name="pulse", label="pulse", unit="bpm",
                       min=45, max=120, hard_min=25, hard_max=220, required=False),
        ],
        cross_field=[CrossFieldRule(left="systolic", right="diastolic")],
    )
