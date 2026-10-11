"""Gem assistant: sessions (context window), frames, turns, annotated image, cached voice."""

from __future__ import annotations

import asyncio
import base64
import io
import json
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.assistant.brain import (
    SYSTEM_PROMPT,
    Annotation,
    BrainError,
    BrainReply,
    MockBrain,
    Prompt,
    PromptFrame,
    build_system_prompt,
    parse_reply,
    response_schema,
)
from app.assistant.render import render
from app.assistant.sessions import SessionStore
from app.config import load_settings
from app.main import create_app
from app.voice import ElevenLabsVoice

from .conftest import bp_protocol_body, jpeg_b64


class FakeClock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


class ScriptedBrain:
    def __init__(self, reply: BrainReply | None = None, error: str | None = None, delay: float = 0) -> None:
        self.reply_value = reply or BrainReply("where is the start button", True, "It's the blue button.",
                                               (Annotation("start", (700, 400, 900, 600)),))
        self.error, self.delay = error, delay
        self.prompts: list[Prompt] = []

    async def reply(self, prompt: Prompt) -> BrainReply:
        self.prompts.append(prompt)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error:
            raise BrainError(self.error)
        return self.reply_value


def make(tmp_path, *, brain=None, voice=None, clock=None, **settings: Any) -> TestClient:
    s = load_settings(database_path=str(tmp_path / "a.db"), mock_ai=True, gemini_api_key="",
                      elevenlabs_api_key="", **settings)
    store = SessionStore(idle_timeout_s=s.session_idle_timeout_s, max_frames=s.session_max_frames,
                         memory_s=s.memory_s, dedupe_threshold=s.frame_dedupe_threshold,
                         keepalive_s=s.frame_keepalive_s, clock=clock or FakeClock())
    return TestClient(create_app(s, brain=brain, voice=voice, session_store=store))


def new_session(c: TestClient) -> str:
    r = c.post("/sessions", json={})
    assert r.status_code == 201, r.text
    return r.json()["session_id"]


def wav_b64(n_bytes: int = 8000) -> str:
    return base64.b64encode(b"RIFF" + b"\0" * n_bytes).decode()


# -- sessions & frames ------------------------------------------------------------


def test_create_and_describe_session(tmp_path) -> None:
    c = make(tmp_path)
    sid = new_session(c)
    body = c.get(f"/sessions/{sid}").json()
    assert body["idle_timeout_s"] == 600 and body["frame_interval_ms"] == 1000
    assert body["frames_buffered"] == 0 and body["turns"] == 0


def test_frames_are_buffered_with_change_score(tmp_path) -> None:
    c = make(tmp_path, session_max_frames=3)
    sid = new_session(c)
    first = c.post(f"/sessions/{sid}/frames", json={"image_base64": jpeg_b64((120, 120, 120))}).json()
    same = c.post(f"/sessions/{sid}/frames", json={"image_base64": jpeg_b64((120, 120, 120))}).json()
    diff = c.post(f"/sessions/{sid}/frames", json={"image_base64": jpeg_b64((250, 250, 250))}).json()
    assert first["change_score"] is None
    assert same["change_score"] == pytest.approx(0, abs=0.01)
    assert diff["change_score"] > 0.4
    c.post(f"/sessions/{sid}/frames", json={"image_base64": jpeg_b64()})
    info = c.get(f"/sessions/{sid}").json()
    assert info["frames_buffered"] == 3 and info["frames_received"] == 4


def test_bad_frame_422(tmp_path) -> None:
    c = make(tmp_path)
    sid = new_session(c)
    r = c.post(f"/sessions/{sid}/frames", json={"image_base64": "bm9wZQ=="})
    assert r.status_code == 422 and r.json()["error"] == "bad_image"


def test_unknown_session_404(tmp_path) -> None:
    c = make(tmp_path)
    assert c.post("/sessions/nope/frames", json={"image_base64": jpeg_b64()}).json()["error"] == "session_not_found"


def test_idle_session_is_purged_after_ten_minutes(tmp_path) -> None:
    clock = FakeClock()
    c = make(tmp_path, clock=clock)
    sid = new_session(c)
    clock.t += 599
    assert c.post(f"/sessions/{sid}/frames", json={"image_base64": jpeg_b64()}).status_code == 200  # activity
    clock.t += 599
    assert c.post(f"/sessions/{sid}/turns", json={"text": "hi"}).status_code == 200  # a prompt is activity too
    clock.t += 599
    assert c.get(f"/sessions/{sid}").status_code == 200  # reading does not extend it
    clock.t += 2
    r = c.post(f"/sessions/{sid}/frames", json={"image_base64": jpeg_b64()})
    assert r.status_code == 410 and r.json()["error"] == "session_expired"


def test_sweeper_purges_without_access(tmp_path) -> None:
    clock = FakeClock()
    c = make(tmp_path, clock=clock)
    store: SessionStore = c.app.state.sessions
    sid = new_session(c)
    clock.t += 601
    assert store.sweep() == 1 and len(store) == 0
    assert c.get(f"/sessions/{sid}").status_code == 410


def test_end_session(tmp_path) -> None:
    c = make(tmp_path)
    sid = new_session(c)
    assert c.delete(f"/sessions/{sid}").status_code == 204
    assert c.get(f"/sessions/{sid}").status_code == 410
    assert c.delete(f"/sessions/{sid}").status_code == 404


# -- turns ------------------------------------------------------------------------


def test_text_turn_returns_annotated_image(tmp_path, fixture_photo_b64) -> None:
    brain = ScriptedBrain()
    c = make(tmp_path, brain=brain)
    sid = new_session(c)
    for _ in range(5):
        c.post(f"/sessions/{sid}/frames", json={"image_base64": fixture_photo_b64})
    r = c.post(f"/sessions/{sid}/turns", json={"text": "Where is the start button?"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "answered" and body["answer"] == "It's the blue button."
    assert body["annotations"] == [{"label": "start", "box_2d": [700, 400, 900, 600]}]
    assert body["frames_used"] == 1  # 5 identical frames -> 1 kept in memory
    assert len(brain.prompts[0].frames) == 1 and brain.prompts[0].frames[0].high_res
    assert brain.prompts[0].text == "Where is the start button?" and brain.prompts[0].audio is None
    img = c.get(body["image_url"])
    assert img.status_code == 200 and img.headers["content-type"] == "image/jpeg"
    with Image.open(io.BytesIO(img.content)) as im:
        assert im.size == (body["image_width"], body["image_height"]) == (768, 576)
    assert body["audio_url"] is None  # no ElevenLabs key


def test_audio_turn_passes_audio_to_gemini(tmp_path) -> None:
    brain = ScriptedBrain()
    c = make(tmp_path, brain=brain)
    sid = new_session(c)
    r = c.post(f"/sessions/{sid}/turns", json={"audio_base64": wav_b64(), "audio_mime": "audio/wav"})
    assert r.status_code == 200
    p = brain.prompts[0]
    assert p.audio is not None and p.audio.startswith(b"RIFF") and p.audio_mime == "audio/wav"
    assert p.frames == [] and r.json()["image_url"] is None


def test_history_is_carried_between_turns(tmp_path) -> None:
    brain = ScriptedBrain()
    c = make(tmp_path, brain=brain)
    sid = new_session(c)
    c.post(f"/sessions/{sid}/turns", json={"text": "first"})
    c.post(f"/sessions/{sid}/turns", json={"text": "second"})
    history = brain.prompts[1].history
    assert history[0] == {"role": "user", "text": "where is the start button"}
    assert history[1]["role"] == "model" and "[Marked on frame" not in history[1]["text"]  # no frames yet


def test_ignored_speech_is_not_answered_or_remembered(tmp_path) -> None:
    brain = ScriptedBrain(BrainReply("(tv noise)", False, "", ()))
    c = make(tmp_path, brain=brain)
    sid = new_session(c)
    body = c.post(f"/sessions/{sid}/turns", json={"audio_base64": wav_b64()}).json()
    assert body["status"] == "ignored" and body["answer"] == "" and body["audio_url"] is None
    c.post(f"/sessions/{sid}/turns", json={"text": "next"})
    assert brain.prompts[1].history == []


@pytest.mark.parametrize("body", [
    {},
    {"text": "a", "audio_base64": "AAAA"},
    {"text": "   "},
    {"audio_base64": "AAAA", "audio_mime": "video/mp4"},
])
def test_turn_input_validation(tmp_path, body) -> None:
    c = make(tmp_path)
    sid = new_session(c)
    r = c.post(f"/sessions/{sid}/turns", json=body)
    assert r.status_code == 422 and r.json()["error"] == "malformed"


def test_bad_audio_base64(tmp_path) -> None:
    c = make(tmp_path)
    sid = new_session(c)
    assert c.post(f"/sessions/{sid}/turns", json={"audio_base64": "!!!"}).json()["error"] == "bad_audio"


@pytest.mark.parametrize("code,status", [("ai_timeout", 504), ("ai_error", 502), ("invalid_output", 502)])
def test_brain_failures(tmp_path, code, status) -> None:
    c = make(tmp_path, brain=ScriptedBrain(error=code))
    sid = new_session(c)
    r = c.post(f"/sessions/{sid}/turns", json={"text": "hi"})
    assert r.status_code == status and r.json()["error"] == code
    assert r.json()["voice_line_id"] == "network_error"


def test_concurrent_turns_rejected(tmp_path) -> None:
    c = make(tmp_path, brain=ScriptedBrain(delay=0.3))
    sid = new_session(c)

    async def run() -> list[int]:
        transport = httpx.ASGITransport(app=c.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as ac:
            first = asyncio.create_task(ac.post(f"/sessions/{sid}/turns", json={"text": "one"}))
            await asyncio.sleep(0.05)
            second = await ac.post(f"/sessions/{sid}/turns", json={"text": "two"})
            return [(await first).status_code, second.status_code]

    assert asyncio.run(run()) == [200, 409]


def test_study_context_comes_from_active_protocol(tmp_path) -> None:
    brain = ScriptedBrain()
    c = make(tmp_path, brain=brain)
    c.post("/protocols", json=bp_protocol_body(prompt_text="Patients use an Omron M7 cuff."))
    sid = new_session(c)
    assert c.get(f"/sessions/{sid}").json()["study_context"] is True
    c.post(f"/sessions/{sid}/turns", json={"text": "hi"})
    assert "<study_context>" in brain.prompts[0].system_prompt
    assert "Omron M7" in brain.prompts[0].system_prompt


def test_mock_brain_end_to_end(tmp_path, fixture_photo_b64) -> None:
    c = make(tmp_path)  # default: MockBrain because no key
    sid = new_session(c)
    c.post(f"/sessions/{sid}/frames", json={"image_base64": fixture_photo_b64})
    body = c.post(f"/sessions/{sid}/turns", json={"text": "what is this?"}).json()
    assert body["status"] == "answered" and body["annotations"][0]["label"] == "look here"
    tiny = c.post(f"/sessions/{sid}/turns", json={"audio_base64": base64.b64encode(b"x" * 100).decode()}).json()
    assert tiny["status"] == "ignored"


# -- voice cache -------------------------------------------------------------------


def voice_counting(calls: list[int], status: int = 200) -> ElevenLabsVoice:
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if status != 200:
            return httpx.Response(status, json={"detail": "nope"})
        return httpx.Response(200, content=b"ID3" + b"a" * 5000, headers={"content-type": "audio/mpeg"})

    settings = load_settings(elevenlabs_api_key="k", mock_ai=False)
    return ElevenLabsVoice(settings, transport=httpx.MockTransport(handler))


def test_speech_is_synthesized_once_then_served_from_ram(tmp_path) -> None:
    calls: list[int] = []
    c = make(tmp_path, brain=ScriptedBrain(), voice=voice_counting(calls))
    sid = new_session(c)
    turn = c.post(f"/sessions/{sid}/turns", json={"text": "hi"}).json()
    first = c.get(turn["audio_url"])
    again = c.get(turn["audio_url"])
    assert first.status_code == again.status_code == 200
    assert first.content == again.content and first.content.startswith(b"ID3")
    assert first.headers["content-length"] == str(len(first.content))  # whole file, not chunked
    assert first.headers["x-gem-audio-cache"] == "miss" and again.headers["x-gem-audio-cache"] == "hit"
    assert len(calls) == 1


def test_speech_failure_502_and_not_cached(tmp_path) -> None:
    calls: list[int] = []
    c = make(tmp_path, brain=ScriptedBrain(), voice=voice_counting(calls, status=401))
    sid = new_session(c)
    turn = c.post(f"/sessions/{sid}/turns", json={"text": "hi"}).json()
    assert c.get(turn["audio_url"]).status_code == 502
    assert c.get(turn["audio_url"]).status_code == 502
    assert len(calls) == 2


def test_speech_disabled_404(tmp_path) -> None:
    c = make(tmp_path, brain=ScriptedBrain())
    sid = new_session(c)
    turn = c.post(f"/sessions/{sid}/turns", json={"text": "hi"}).json()
    assert c.get(f"/sessions/{sid}/turns/{turn['turn_id']}/speech").json()["error"] == "voice_disabled"


# -- brain parsing & prompt ------------------------------------------------------------


def reply_json(**over: Any) -> str:
    base = {"transcript": "where", "is_request": True, "answer": "Here.",
            "annotations": [{"label": "cuff", "box_2d": [100, 100, 500, 500]}]}
    base.update(over)
    return json.dumps(base)


def test_parse_frame_id_validation() -> None:
    assert parse_reply(reply_json(frame_id=7), [7, 9]).frame_id == 7
    unknown = parse_reply(reply_json(frame_id=42), [7, 9])
    assert unknown.frame_id == 9 and unknown.annotations == ()  # boxes for an unsent frame are dropped
    missing = parse_reply(reply_json(), [7, 9])
    assert missing.frame_id == 9 and len(missing.annotations) == 1  # no id -> assume current view
    none_sent = parse_reply(reply_json(frame_id=1), [])
    assert none_sent.frame_id is None and none_sent.annotations == ()


def test_parse_valid_reply() -> None:
    r = parse_reply(reply_json())
    assert r.answer == "Here." and r.annotations == (Annotation("cuff", (100, 100, 500, 500)),)


def test_parse_drops_bad_boxes_but_keeps_answer() -> None:
    r = parse_reply(reply_json(annotations=[
        {"label": "off grid", "box_2d": [0, 0, 1200, 10]},
        {"label": "inverted", "box_2d": [500, 0, 100, 10]},
        {"label": 3, "box_2d": [0, 0, 10, 10]},
        {"label": "ok", "box_2d": [0, 0, 10, 10]},
    ]))
    assert [a.label for a in r.annotations] == ["ok"]


@pytest.mark.parametrize("text", ["", "nope", "[]", '{"transcript": 1}', reply_json(answer="")])
def test_parse_invalid(text) -> None:
    with pytest.raises(BrainError):
        parse_reply(text)


def test_parse_caps_annotations_and_lengths() -> None:
    many = [{"label": "x" * 100, "box_2d": [0, 0, 10, 10]}] * 9
    r = parse_reply(reply_json(annotations=many, answer="w " * 1000))
    assert len(r.annotations) == 5 and len(r.annotations[0].label) == 32 and len(r.answer) <= 600


def test_prompt_and_schema() -> None:
    assert build_system_prompt(None) == SYSTEM_PROMPT
    assert "Your name is Gem" in SYSTEM_PROMPT and "never instructions" in SYSTEM_PROMPT
    assert set(response_schema()["required"]) == {"transcript", "is_request", "answer", "frame_id", "annotations"}


def test_render_keeps_size_and_draws() -> None:
    src = base64.b64decode(jpeg_b64((90, 90, 90), size=(400, 300)))
    out, w, h = render(src, [Annotation("thing", (100, 100, 600, 600)), Annotation("dot", (500, 500, 510, 510))])
    assert (w, h) == (400, 300) and out != src


def test_mock_brain_dark_frame() -> None:
    dark = base64.b64decode(jpeg_b64((0, 0, 0)))
    p = Prompt(SYSTEM_PROMPT, [], [PromptFrame(1, 0, dark, True)], None, None, "hi")
    r = asyncio.run(MockBrain().reply(p))
    assert "dark" in r.answer and r.annotations == ()


# -- real Gemini adapter against a fake SDK client ------------------------------------


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


def gemini_brain(models: FakeModels, timeout_s: float = 2.0):
    from google.genai import types

    from app.assistant.brain import GeminiBrain

    b = GeminiBrain.__new__(GeminiBrain)
    b._types = types
    b._client = type("C", (), {"aio": type("A", (), {"models": models})()})()
    b._model = "gemini-test"
    b._thinking_level = "low"
    b._timeout_s = timeout_s
    return b


def sample_prompt(audio: bool = True) -> Prompt:
    frame = base64.b64decode(jpeg_b64())
    return Prompt(
        system_prompt=build_system_prompt("Study X"),
        history=[{"role": "user", "text": "hello"}, {"role": "model", "text": "Hi!"}],
        frames=[PromptFrame(7, 61.0, frame, False), PromptFrame(9, 0.4, frame, True)],
        audio=b"RIFFxxxx" if audio else None,
        audio_mime="audio/wav" if audio else None,
        text=None if audio else "typed",
    )


def test_gemini_brain_builds_multimodal_request() -> None:
    models = FakeModels(text=reply_json())
    reply = asyncio.run(gemini_brain(models).reply(sample_prompt()))
    assert reply.answer == "Here."
    contents = models.kwargs["contents"]
    # [memory frames][ack][history...][question]: frames first so the prefix is cacheable
    assert [c.role for c in contents] == ["user", "model", "user", "model", "user"]
    memory = contents[0].parts
    images = [p for p in memory if p.inline_data]
    assert [p.media_resolution.level.value for p in images] == ["MEDIA_RESOLUTION_LOW", "MEDIA_RESOLUTION_HIGH"]
    labels = [p.text for p in memory if p.text]
    assert "Frame 7, 61 seconds ago:" in labels and "Frame 9, 0 seconds ago (CURRENT VIEW):" in labels
    last = contents[-1].parts
    assert [p.inline_data.mime_type for p in last if p.inline_data] == ["audio/wav"]
    cfg = models.kwargs["config"]
    assert cfg.response_mime_type == "application/json" and "Study X" in cfg.system_instruction


def test_gemini_brain_typed_text_and_errors() -> None:
    models = FakeModels(text=reply_json())
    asyncio.run(gemini_brain(models).reply(sample_prompt(audio=False)))
    assert any("typed" in (p.text or "") for p in models.kwargs["contents"][-1].parts)
    with pytest.raises(BrainError) as exc:
        asyncio.run(gemini_brain(FakeModels(text=reply_json(), delay=1), timeout_s=0.05).reply(sample_prompt()))
    assert exc.value.code == "ai_timeout"
    with pytest.raises(BrainError) as exc:
        asyncio.run(gemini_brain(FakeModels(exc=RuntimeError("quota"))).reply(sample_prompt()))
    assert exc.value.code == "ai_error"



# -- visual memory -----------------------------------------------------------------------


def solid(color: tuple[int, int, int]) -> str:
    return jpeg_b64(color, size=(320, 240))


def test_unchanged_frames_are_not_stored_but_keepalive_is() -> None:
    clock = FakeClock()
    store = SessionStore(idle_timeout_s=600, max_frames=300, memory_s=300, dedupe_threshold=0.02,
                         keepalive_s=30, clock=clock)
    s = store.create("p", None)
    jpeg = base64.b64decode(solid((100, 100, 100)))
    kept = []
    for _ in range(40):  # 40 s of the same scene
        kept.append(store.add_frame(s, jpeg, 320, 240, 100)[1])
        clock.t += 1
    assert kept[0] is True and sum(kept) == 2  # first frame + one keepalive at 30 s
    other = base64.b64decode(solid((240, 30, 30)))
    assert store.add_frame(s, other, 320, 240, 100)[1] is True  # scene changed
    assert [f.frame_id for f in store.memory(s)] == [1, 2, 3]


def test_memory_forgets_frames_older_than_memory_window() -> None:
    clock = FakeClock()
    store = SessionStore(idle_timeout_s=600, max_frames=300, memory_s=120, clock=clock)
    s = store.create("p", None)
    for i in range(10):
        store.add_frame(s, base64.b64decode(solid((i * 25, 0, 0))), 320, 240, 50)
        clock.t += 20
    remembered = store.memory(s)
    assert all(clock.t - f.received_at <= 120 for f in remembered)
    assert len(remembered) == 6


def test_gem_can_point_at_something_seen_a_minute_ago(tmp_path) -> None:
    """Show a 'backpack' (red frame), look elsewhere for a minute, then ask where it was."""
    clock = FakeClock()

    class RecallBrain:
        prompts: list[Prompt] = []

        async def reply(self, prompt: Prompt) -> BrainReply:
            self.prompts.append(prompt)
            first = prompt.frames[0]
            return BrainReply("where is my backpack", True, "About a minute ago, on the chair.",
                              (Annotation("backpack", (100, 100, 900, 900)),), first.frame_id)

    brain = RecallBrain()
    c = make(tmp_path, brain=brain, clock=clock)
    sid = new_session(c)
    c.post(f"/sessions/{sid}/frames", json={"image_base64": solid((220, 20, 20))})  # backpack (red)
    for i in range(60):  # a minute of looking at other things
        clock.t += 1
        c.post(f"/sessions/{sid}/frames", json={"image_base64": solid((20, 20 + i * 3, 200))})
    body = c.post(f"/sessions/{sid}/turns", json={"text": "Where did I leave my backpack?"}).json()

    sent = brain.prompts[0].frames
    assert sent[0].age_s == pytest.approx(60, abs=1) and 10 < len(sent) < 61  # near-duplicates skipped
    assert [f.high_res for f in sent][-2:] == [True, True] and not any(f.high_res for f in sent[:-2])
    assert body["frame_id"] == sent[0].frame_id and body["frame_age_s"] == pytest.approx(60, abs=1)
    img = c.get(body["image_url"]).content
    with Image.open(io.BytesIO(img)) as im:
        r, g, b = im.convert("RGB").getpixel((160, 120))  # centre: inside the box, the red backpack frame
    assert r > 150 and g < 90 and b < 90


def test_mock_brain_recalls_oldest_frame(tmp_path) -> None:
    clock = FakeClock()
    c = make(tmp_path, clock=clock)
    sid = new_session(c)
    c.post(f"/sessions/{sid}/frames", json={"image_base64": solid((200, 200, 200))})
    clock.t += 45
    c.post(f"/sessions/{sid}/frames", json={"image_base64": solid((40, 40, 160))})
    body = c.post(f"/sessions/{sid}/turns", json={"text": "What did you see earlier?"}).json()
    assert body["frame_id"] == 1 and body["frame_age_s"] == pytest.approx(45)
    assert "45 seconds ago" in body["answer"]


# -- barge-in ------------------------------------------------------------------------------


def test_is_echo() -> None:
    from app.assistant.echo import is_echo

    answer = "The yellow chair is on the left, next to the window. I've marked it."
    assert is_echo("the yellow chair is on the left next to the window", answer)
    assert not is_echo("wait no the other chair", answer)
    assert not is_echo("yellow chair", answer)  # too short to judge
    assert not is_echo("the yellow chair is on the left", None)


def test_interruption_is_flagged_and_correction_sees_previous_boxes(tmp_path) -> None:
    clock = FakeClock()
    brain = ScriptedBrain(BrainReply("where is the yellow chair", True, "It's this one.",
                                     (Annotation("yellow chair", (100, 100, 400, 300)),)))
    c = make(tmp_path, brain=brain, clock=clock)
    sid = new_session(c)
    c.post(f"/sessions/{sid}/frames", json={"image_base64": solid((200, 200, 40))})
    c.post(f"/sessions/{sid}/turns", json={"text": "Where is the yellow chair?"})
    brain.reply_value = BrainReply("wait no the other chair", True, "Sorry, this one.",
                                   (Annotation("yellow chair", (500, 600, 900, 900)),))
    r = c.post(f"/sessions/{sid}/turns", json={"audio_base64": wav_b64(), "interrupted": True})
    assert r.status_code == 200 and r.json()["status"] == "answered"
    second = brain.prompts[1]
    assert second.interrupted is True
    assert "yellow chair at [100, 100, 400, 300]" in second.history[1]["text"]


def test_gem_hearing_itself_is_ignored(tmp_path) -> None:
    brain = ScriptedBrain(BrainReply("hi", True, "The start button is the round blue one below the screen.", ()))
    c = make(tmp_path, brain=brain)
    sid = new_session(c)
    c.post(f"/sessions/{sid}/turns", json={"text": "hi"})
    brain.reply_value = BrainReply("the start button is the round blue one", True, "Yes.", ())
    body = c.post(f"/sessions/{sid}/turns", json={"audio_base64": wav_b64(), "interrupted": True}).json()
    assert body["status"] == "ignored" and body["answer"] == ""
    assert len(brain.prompts[1].history) == 2  # echo not added to the conversation


def test_gemini_is_told_about_the_interruption() -> None:
    models = FakeModels(text=reply_json())
    p = sample_prompt()
    p = Prompt(p.system_prompt, p.history, p.frames, p.audio, p.audio_mime, p.text, interrupted=True)
    asyncio.run(gemini_brain(models).reply(p))
    texts = [part.text or "" for part in models.kwargs["contents"][-1].parts]
    assert any("interrupted your previous answer" in t for t in texts)
    assert "the other chair" in models.kwargs["config"].system_instruction
