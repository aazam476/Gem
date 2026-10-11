"""Fixed patient-facing lines and deterministic read-back sentences.

The same IDs/texts live in mobile/src/services/voiceLines.json so the app can speak
them offline (if the network is the problem, we cannot call ElevenLabs to say so).
tests/test_voice_lines.py keeps the two copies in sync.
"""

from __future__ import annotations

from .rules import ValidationRules

VOICE_LINES: dict[str, str] = {
    "retake_unclear": "I couldn't quite see that clearly. Can you hold the camera steady?",
    "retake_unusual": "That reading looks unusual. Let's take it one more time to be safe.",
    "retake_requested": "No problem. Let's take it again.",
    "network_error": "I'm having trouble connecting right now. Let's try again in a moment.",
    "saved": "Thank you. Your reading has been saved.",
    "saved_flagged": (
        "Thank you. I've saved that reading, and your study team will take a look at it."
    ),
    "already_saved": "That reading was already saved. You're all set.",
}


def _fmt(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else f"{value:g}"


def readback(rules: ValidationRules, values: dict[str, float]) -> str:
    """Build the confirmation sentence from validated numbers, never from LLM prose."""
    names = {m.name for m in rules.metrics}
    parts: list[str] = []
    remaining = dict(values)
    if {"systolic", "diastolic"} <= names and "systolic" in values and "diastolic" in values:
        parts.append(f"{_fmt(remaining.pop('systolic'))} over {_fmt(remaining.pop('diastolic'))}")
    for metric in rules.metrics:
        if metric.name in remaining:
            parts.append(f"{metric.display_name} {_fmt(remaining[metric.name])}")
    if not parts:
        return "I couldn't find a number. Is the screen showing a reading?"
    if len(parts) == 1:
        joined = parts[0]
    else:
        joined = ", ".join(parts[:-1]) + ", and " + parts[-1]
    return f"I read {joined}. Is that right?"
