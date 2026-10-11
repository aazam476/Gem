"""Opt-in checks against the real APIs. Never run by default.

    GEM_LIVE_TESTS=1 GEMINI_API_KEY=... ELEVENLABS_API_KEY=... pytest tests/test_live.py -s
"""

from __future__ import annotations

import asyncio

import pytest

from app.config import load_settings
from app.imaging import prepare_image
from app.rules import blood_pressure_preset
from app.vision import GeminiVision
from app.voice import ElevenLabsVoice

from .conftest import LIVE, FIXTURES

pytestmark = [pytest.mark.live, pytest.mark.skipif(not LIVE, reason="set GEM_LIVE_TESTS=1")]


def test_gemini_reads_fixture_photo() -> None:
    import base64

    settings = load_settings()
    assert settings.gemini_api_key, "GEMINI_API_KEY missing"
    data = base64.b64encode((FIXTURES / "bp_monitor_synthetic.jpg").read_bytes()).decode()
    image = prepare_image(data, max_bytes=10**7, long_edge=1024)
    result = asyncio.run(GeminiVision(settings).analyze(
        image, "Find the blood pressure reading on the monitor.", blood_pressure_preset()))
    print(result)
    assert result.found
    assert result.readings["systolic"] == 128
    assert result.readings["diastolic"] == 82


def test_elevenlabs_returns_audio() -> None:
    settings = load_settings()
    assert settings.elevenlabs_api_key, "ELEVENLABS_API_KEY missing"
    audio = asyncio.run(ElevenLabsVoice(settings).synthesize("Hello from Gem."))
    assert len(audio) > 1000


def test_assistant_answers_about_fixture_photo() -> None:
    import base64

    from app.assistant.brain import GeminiBrain, Prompt, build_system_prompt

    settings = load_settings()
    assert settings.gemini_api_key, "GEMINI_API_KEY missing"
    image = prepare_image(base64.b64encode((FIXTURES / "bp_monitor_synthetic.jpg").read_bytes()).decode(),
                          max_bytes=10**7, long_edge=768)
    prompt = Prompt(build_system_prompt(None), [], [image.jpeg], None, None,
                    "What is my blood pressure, and where is the start button?")
    reply = asyncio.run(GeminiBrain(settings).reply(prompt))
    print(reply)
    assert reply.is_request and "128" in reply.answer
    assert reply.annotations, "expected Gemini to mark something"
