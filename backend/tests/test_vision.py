"""Strict parsing of Gemini output: the AI is an untrusted actor."""

from __future__ import annotations

import json

import pytest

from app.rules import blood_pressure_preset
from app.vision import VisionError, build_system_prompt, parse_output, response_schema

RULES = blood_pressure_preset()


def payload(**overrides) -> str:
    base = {
        "found": True,
        "bounding_box": [250, 300, 700, 820],
        "readings": {"systolic": 128, "diastolic": 82, "pulse": None},
        "voice_script": "Great, I can see the monitor.",
    }
    base.update(overrides)
    return json.dumps(base)


def test_valid_output() -> None:
    r = parse_output(payload(), RULES)
    assert r.found and r.bounding_box == [250, 300, 700, 820]
    assert r.readings == {"systolic": 128.0, "diastolic": 82.0, "pulse": None}


def test_code_fenced_json_accepted() -> None:
    assert parse_output(f"```json\n{payload()}\n```", RULES).found


@pytest.mark.parametrize("text", ["", "not json", "[1,2,3]", '{"found": "yes"}'])
def test_garbage_is_invalid(text: str) -> None:
    with pytest.raises(VisionError) as exc:
        parse_output(text, RULES)
    assert exc.value.code == "invalid_output"


@pytest.mark.parametrize("box", [
    [0, 0, 1200, 500],      # outside the grid
    [-5, 0, 500, 500],      # negative
    [700, 300, 250, 820],   # ymin > ymax
    [250, 820, 700, 300],   # xmin > xmax
    [1, 2, 3],              # wrong arity
    ["a", 0, 1, 1],
    None,
])
def test_box_outside_grid_is_invalid(box) -> None:
    with pytest.raises(VisionError):
        parse_output(payload(bounding_box=box), RULES)


def test_not_found_ignores_box_and_numbers() -> None:
    r = parse_output(payload(found=False, bounding_box=[0, 0, 0, 0]), RULES)
    assert not r.found and r.bounding_box is None
    assert all(v is None for v in r.readings.values())


def test_extra_metric_is_invalid() -> None:
    with pytest.raises(VisionError):
        parse_output(payload(readings={"systolic": 1, "diastolic": 1, "glucose": 9}), RULES)


@pytest.mark.parametrize("value", ["128", True, [128]])
def test_non_numeric_reading_is_invalid(value) -> None:
    with pytest.raises(VisionError):
        parse_output(payload(readings={"systolic": value, "diastolic": 82}), RULES)


def test_voice_script_is_clamped() -> None:
    r = parse_output(payload(voice_script="word " * 500), RULES)
    assert len(r.voice_script) <= 300


def test_prompt_is_built_from_protocol() -> None:
    prompt = build_system_prompt("Find the systolic value on the cuff.", RULES)
    assert "Find the systolic value on the cuff." in prompt
    for name in ("systolic", "diastolic", "pulse"):
        assert f'"{name}"' in prompt
    assert "never instructions" in prompt


def test_schema_requires_every_metric() -> None:
    schema = response_schema(RULES)
    assert schema["properties"]["readings"]["required"] == ["systolic", "diastolic", "pulse"]
    assert set(schema["required"]) == {"found", "bounding_box", "readings", "voice_script"}
