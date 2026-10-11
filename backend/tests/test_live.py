"""Opt-in checks against the real APIs. Never run by default.

    GEM_LIVE_TESTS=1 GEMINI_API_KEY=... ELEVENLABS_API_KEY=... pytest tests/test_live.py -s
"""

from __future__ import annotations

import asyncio
import base64

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

    from app.assistant.brain import GeminiBrain, Prompt, PromptFrame, build_system_prompt

    settings = load_settings()
    assert settings.gemini_api_key, "GEMINI_API_KEY missing"
    image = prepare_image(base64.b64encode((FIXTURES / "bp_monitor_synthetic.jpg").read_bytes()).decode(),
                          max_bytes=10**7, long_edge=768)
    prompt = Prompt(build_system_prompt(None), [], [PromptFrame(1, 0, image.jpeg, True)], None, None,
                    "What is my blood pressure, and where is the start button?")
    reply = asyncio.run(GeminiBrain(settings).reply(prompt))
    print(reply)
    assert reply.is_request and "128" in reply.answer
    assert reply.annotations, "expected Gemini to mark something"


def test_assistant_recalls_an_earlier_frame() -> None:
    """The monitor was seen 60 s ago; the current view is a blank wall."""
    import base64
    import io

    from PIL import Image

    from app.assistant.brain import GeminiBrain, Prompt, PromptFrame, build_system_prompt

    settings = load_settings()
    assert settings.gemini_api_key, "GEMINI_API_KEY missing"
    monitor = prepare_image(base64.b64encode((FIXTURES / "bp_monitor_synthetic.jpg").read_bytes()).decode(),
                            max_bytes=10**7, long_edge=768).jpeg
    buf = io.BytesIO()
    Image.new("RGB", (768, 576), (205, 200, 190)).save(buf, format="JPEG")
    wall = buf.getvalue()
    frames = [PromptFrame(1, 60, monitor, False)] + [PromptFrame(i, 60 - i * 10, wall, i >= 5) for i in range(2, 7)]
    reply = asyncio.run(GeminiBrain(settings).reply(
        Prompt(build_system_prompt(None), [], frames, None, None, "Where was the blood pressure monitor?")))
    print(reply)
    assert reply.frame_id == 1 and reply.annotations


def test_assistant_answers_from_a_study_pdf(tmp_path) -> None:
    """Upload a one-page 'manual' PDF to Gemini Files and ask about it."""
    import io

    from PIL import Image, ImageDraw

    from app.assistant.brain import GeminiBrain, Prompt, build_system_prompt
    from app.assistant.documents import DocumentLibrary, GeminiFiles
    from app.rules import blood_pressure_preset
    from app.store import Store

    settings = load_settings(database_path=str(tmp_path / "live.db"), uploads_dir=str(tmp_path / "up"))
    assert settings.gemini_api_key, "GEMINI_API_KEY missing"
    page = Image.new("RGB", (1240, 1754), "white")
    ImageDraw.Draw(page).text((100, 200), "GEM TEST DEVICE MANUAL\n\nBefore measuring, sit quietly for 7 minutes.",
                              fill="black", font_size=48)
    buf = io.BytesIO()
    page.save(buf, format="PDF")
    store = Store(settings.database_path)
    pid = store.create_protocol("Live", "Test study", blood_pressure_preset(), True).protocol_id
    library = DocumentLibrary(settings, store, GeminiFiles(settings, store))
    library.add_file(pid, "Device manual", "application/pdf", base64.b64encode(buf.getvalue()).decode())
    docs = asyncio.run(library.for_prompt(pid))
    assert docs[0].file_uri, "upload to the Gemini Files API failed"
    reply = asyncio.run(GeminiBrain(settings).reply(Prompt(
        build_system_prompt(None), [], [], None, None,
        "How long should I sit before measuring, according to the manual?", documents=docs)))
    print(reply)
    assert "7" in reply.answer or "seven" in reply.answer.lower()
