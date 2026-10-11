"""End-to-end capture pipeline with mocked Gemini and ElevenLabs (no live calls)."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.voice import ElevenLabsVoice
from app.config import load_settings
from app.vision import VisionError, parse_output

from .conftest import bp_protocol_body, jpeg_b64, make_client

PATIENT = {"patient_id": "patient-demo-001", "session_id": "session-1"}


class ScriptedVision:
    """Returns a canned raw Gemini response (or raises) to drive each branch."""

    def __init__(self, raw: str | None = None, error: str | None = None, delay: float = 0) -> None:
        self.raw, self.error, self.delay = raw, error, delay
        self.calls = 0

    async def analyze(self, image, prompt_text, rules):
        self.calls += 1
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error:
            raise VisionError(self.error)
        return parse_output(self.raw or "", rules)


def gemini_json(**overrides: Any) -> str:
    base = {
        "found": True,
        "bounding_box": [280, 220, 720, 780],
        "readings": {"systolic": 142, "diastolic": 90, "pulse": None},
        "voice_script": "Nice and steady.",
    }
    base.update(overrides)
    return json.dumps(base)


def setup(tmp_path, **kwargs) -> tuple[TestClient, str]:
    client = make_client(tmp_path, **kwargs)
    client.__enter__()
    pid = client.post("/protocols", json=bp_protocol_body()).json()["protocol_id"]
    return client, pid


def capture(client: TestClient, pid: str, image: str | None = None):
    return client.post("/captures", json={"protocol_id": pid, "image_base64": image or jpeg_b64(), **PATIENT})


def test_mock_mode_reads_fixture_photo(tmp_path, fixture_photo_b64: str) -> None:
    client, pid = setup(tmp_path)
    r = capture(client, pid, fixture_photo_b64)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "needs_confirmation"
    assert body["readings"] == {"systolic": 128.0, "diastolic": 82.0, "pulse": 71.0}
    assert body["voice_script"] == "I read 128 over 82, and pulse 71. Is that right?"
    assert (body["image_width"], body["image_height"]) == (1280, 960)
    assert body["audio_url"] is None  # voice disabled in mock mode
    assert client.get("/health").json()["ai_mode"] == "mock"


def test_confirm_stores_exactly_once(tmp_path) -> None:
    client, pid = setup(tmp_path, vision=ScriptedVision(gemini_json()))
    cap = capture(client, pid).json()
    ok = client.post(f"/captures/{cap['capture_id']}/confirm", json={"idempotency_key": "key-a"})
    assert ok.status_code == 201
    assert ok.json()["event"]["extracted_data"] == {"systolic": 142.0, "diastolic": 90.0}
    assert ok.json()["event"]["capture_id"] == cap["capture_id"]

    # retry with the same key (e.g. response lost on a flaky network)
    retry = client.post(f"/captures/{cap['capture_id']}/confirm", json={"idempotency_key": "key-a"})
    assert retry.status_code == 409 and retry.json()["error"] == "duplicate"
    assert retry.json()["voice_line_id"] == "already_saved"
    # a second confirm with a *new* key still cannot double-count the capture
    other = client.post(f"/captures/{cap['capture_id']}/confirm", json={"idempotency_key": "key-b"})
    assert other.status_code == 409
    assert len(client.get("/events").json()) == 1


def test_hallucinated_value_blocked_before_confirmation(tmp_path) -> None:
    raw = gemini_json(readings={"systolic": 900, "diastolic": 82, "pulse": None})
    client, pid = setup(tmp_path, vision=ScriptedVision(raw))
    body = capture(client, pid).json()
    assert body["status"] == "rejected" and body["reason"] == "gateway_rejected"
    assert body["voice_line_id"] == "retake_unusual"
    assert body["voice_script"].startswith("That reading looks unusual")
    confirm = client.post(f"/captures/{body['capture_id']}/confirm", json={"idempotency_key": "k"})
    assert confirm.status_code == 409 and confirm.json()["error"] == "capture_not_confirmable"
    assert client.get("/events").json() == []
    assert client.get("/rejections").json()[0]["capture_id"] == body["capture_id"]


def test_high_but_plausible_reading_is_flagged_and_saved(tmp_path) -> None:
    raw = gemini_json(readings={"systolic": 210, "diastolic": 100, "pulse": None})
    client, pid = setup(tmp_path, vision=ScriptedVision(raw))
    body = capture(client, pid).json()
    assert body["status"] == "needs_confirmation"
    assert body["flags"][0]["code"] == "above_range"
    r = client.post(f"/captures/{body['capture_id']}/confirm", json={"idempotency_key": "k"})
    assert r.status_code == 201 and r.json()["result"] == "flagged"
    assert r.json()["voice_line_id"] == "saved_flagged"


def test_invalid_ai_output_drops_frame(tmp_path) -> None:
    client, pid = setup(tmp_path, vision=ScriptedVision(gemini_json(bounding_box=[0, 0, 5000, 10])))
    body = capture(client, pid).json()
    assert body["status"] == "unreadable" and body["reason"] == "invalid_output"
    assert body["voice_script"] == "I couldn't quite see that clearly. Can you hold the camera steady?"
    assert body["bounding_box"] is None


def test_display_not_found_uses_gemini_guidance(tmp_path) -> None:
    raw = gemini_json(found=False, bounding_box=[0, 0, 0, 0], voice_script="Try moving a bit closer.")
    client, pid = setup(tmp_path, vision=ScriptedVision(raw))
    body = capture(client, pid).json()
    assert body["status"] == "unreadable" and body["reason"] == "no_display"
    assert body["voice_script"] == "Try moving a bit closer."


def test_dark_frame_unreadable_in_mock_mode(tmp_path) -> None:
    client, pid = setup(tmp_path)
    body = capture(client, pid, jpeg_b64((0, 0, 0))).json()
    assert body["status"] == "unreadable"


@pytest.mark.parametrize("code", ["ai_timeout", "ai_error"])
def test_ai_failure_maps_to_network_line(tmp_path, code: str) -> None:
    client, pid = setup(tmp_path, vision=ScriptedVision(error=code))
    body = capture(client, pid).json()
    assert body["status"] == "unreadable" and body["reason"] == code
    assert body["voice_line_id"] == "network_error"


class FakeModels:
    def __init__(self, text: str = "", delay: float = 0, exc: Exception | None = None) -> None:
        self.text, self.delay, self.exc = text, delay, exc
        self.kwargs: dict[str, Any] = {}

    async def generate_content(self, **kwargs: Any):
        self.kwargs = kwargs
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.exc:
            raise self.exc
        return type("Resp", (), {"text": self.text})()


def gemini_with(models: FakeModels, timeout_s: float = 2.0):
    from google.genai import types

    from app.vision import GeminiVision

    vision = GeminiVision.__new__(GeminiVision)
    vision._genai_types = types
    vision._client = type("C", (), {"aio": type("A", (), {"models": models})()})()
    vision._model = "gemini-test"
    vision._thinking_level = "low"
    vision._timeout_s = timeout_s
    return vision


def analyze(vision):
    from app.imaging import prepare_image
    from app.rules import blood_pressure_preset

    image = prepare_image(jpeg_b64(), max_bytes=10**7, long_edge=512)
    return asyncio.run(vision.analyze(image, "Read the cuff.", blood_pressure_preset()))


def test_gemini_adapter_sends_structured_request() -> None:
    models = FakeModels(text=gemini_json())
    result = analyze(gemini_with(models))
    assert result.readings["systolic"] == 142.0
    config = models.kwargs["config"]
    assert models.kwargs["model"] == "gemini-test"
    assert config.response_mime_type == "application/json"
    assert "readings" in config.response_json_schema["properties"]
    assert "Read the cuff." in config.system_instruction


def test_gemini_adapter_enforces_timeout_budget() -> None:
    with pytest.raises(VisionError) as exc:
        analyze(gemini_with(FakeModels(text=gemini_json(), delay=1), timeout_s=0.05))
    assert exc.value.code == "ai_timeout"


def test_gemini_adapter_wraps_api_errors() -> None:
    with pytest.raises(VisionError) as exc:
        analyze(gemini_with(FakeModels(exc=RuntimeError("404 model not found"))))
    assert exc.value.code == "ai_error"


def test_bad_image_422(tmp_path) -> None:
    client, pid = setup(tmp_path)
    r = capture(client, pid, "bm90IGFuIGltYWdl")
    assert r.status_code == 422 and r.json()["error"] == "bad_image"


def test_capture_requires_active_protocol(tmp_path) -> None:
    client, pid = setup(tmp_path)
    client.post(f"/protocols/{pid}/deactivate")
    assert capture(client, pid).status_code == 409


def test_discard_then_confirm_refused(tmp_path) -> None:
    client, pid = setup(tmp_path, vision=ScriptedVision(gemini_json()))
    cid = capture(client, pid).json()["capture_id"]
    d = client.post(f"/captures/{cid}/discard")
    assert d.status_code == 200 and d.json()["voice_line_id"] == "retake_requested"
    assert client.post(f"/captures/{cid}/confirm", json={"idempotency_key": "k"}).status_code == 409


def test_expired_capture_410(tmp_path) -> None:
    client, pid = setup(tmp_path, vision=ScriptedVision(gemini_json()), capture_ttl_s=60)
    cid = capture(client, pid).json()["capture_id"]
    store = client.app.state.store
    old = (datetime.now(UTC) - timedelta(minutes=5)).isoformat()
    store._conn.execute("UPDATE captures SET created_at = ? WHERE capture_id = ?", (old, cid))
    r = client.post(f"/captures/{cid}/confirm", json={"idempotency_key": "k"})
    assert r.status_code == 410


def test_unknown_capture_404(tmp_path) -> None:
    client, _ = setup(tmp_path)
    assert client.post("/captures/nope/confirm", json={"idempotency_key": "k"}).status_code == 404


# -- voice ------------------------------------------------------------------------


def voice_with(handler) -> ElevenLabsVoice:
    settings = load_settings(elevenlabs_api_key="test-key", mock_ai=False)
    return ElevenLabsVoice(settings, transport=httpx.MockTransport(handler))


def test_speech_disabled_without_key(tmp_path) -> None:
    client, pid = setup(tmp_path, vision=ScriptedVision(gemini_json()))
    cid = capture(client, pid).json()["capture_id"]
    assert client.get(f"/captures/{cid}/speech").status_code == 404


def test_speech_streams_elevenlabs_audio(tmp_path) -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        seen["key"] = request.headers["xi-api-key"]
        return httpx.Response(200, content=b"ID3fake-mp3-bytes", headers={"content-type": "audio/mpeg"})

    client, pid = setup(tmp_path, vision=ScriptedVision(gemini_json()), voice=voice_with(handler))
    cap = capture(client, pid).json()
    assert cap["audio_url"] == f"/captures/{cap['capture_id']}/speech"
    r = client.get(cap["audio_url"])
    assert r.status_code == 200 and r.content == b"ID3fake-mp3-bytes"
    assert r.headers["content-type"] == "audio/mpeg"
    assert seen["body"] == {"text": "I read 142 over 90. Is that right?", "model_id": "eleven_flash_v2_5"}
    assert seen["key"] == "test-key"


def test_speech_failure_502_so_app_falls_back(tmp_path) -> None:
    client, pid = setup(
        tmp_path, vision=ScriptedVision(gemini_json()),
        voice=voice_with(lambda r: httpx.Response(401, json={"detail": "bad key"})),
    )
    cap = capture(client, pid).json()
    r = client.get(cap["audio_url"])
    assert r.status_code == 502 and r.json()["error"] == "voice_unavailable"


def test_mock_vision_used_when_no_key(tmp_path) -> None:
    client, _ = setup(tmp_path, mock_ai=False)
    assert client.get("/health").json()["ai_mode"] == "mock"
