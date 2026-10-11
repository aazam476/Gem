from __future__ import annotations

import json
from pathlib import Path

from app.rules import MetricRule, ValidationRules, blood_pressure_preset
from app.voice_lines import VOICE_LINES, readback

MOBILE_LINES = Path(__file__).resolve().parents[2] / "mobile" / "src" / "services" / "voiceLines.json"


def test_mobile_offline_lines_match_backend() -> None:
    assert json.loads(MOBILE_LINES.read_text()) == VOICE_LINES


def test_blood_pressure_readback() -> None:
    text = readback(blood_pressure_preset(), {"systolic": 142.0, "diastolic": 90.0})
    assert text == "I read 142 over 90. Is that right?"


def test_readback_with_pulse() -> None:
    text = readback(blood_pressure_preset(), {"systolic": 120.0, "diastolic": 80.0, "pulse": 64.0})
    assert text == "I read 120 over 80, and pulse 64. Is that right?"


def test_generic_metric_readback() -> None:
    rules = ValidationRules(metrics=[
        MetricRule(name="temp_c", label="temperature", min=36, max=38, hard_min=30, hard_max=45),
    ])
    assert readback(rules, {"temp_c": 37.2}) == "I read temperature 37.2. Is that right?"
