"""Detect when the "question" is really Gem's own answer picked up by the microphone.

While Gem speaks, the mic stays open so the user can interrupt. On-device barge-in
detection filters most of the echo, but if some gets through, Gemini transcribes Gem's
own words back. Those turns are ignored deterministically here (and the prompt also tells
Gemini to set is_request=false for them).
"""

from __future__ import annotations

import re

_WORD = re.compile(r"[a-z0-9']+")


def _words(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def is_echo(transcript: str, last_answer: str | None, threshold: float = 0.7) -> bool:
    """True when most of the transcript's words appear, in order-insensitive bag terms, in
    Gem's last answer and the transcript is long enough to judge (>= 4 words)."""
    if not last_answer:
        return False
    heard = _words(transcript)
    if len(heard) < 4:
        return False
    said = set(_words(last_answer))
    overlap = sum(1 for w in heard if w in said) / len(heard)
    return overlap >= threshold
