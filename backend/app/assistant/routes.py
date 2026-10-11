"""HTTP routes for the Gem assistant. Contract: docs/API_CONTRACT.md §Assistant."""

from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import logging
import time
import uuid
from collections.abc import AsyncIterator, Callable
from typing import Any, Literal

from fastapi import APIRouter, FastAPI, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..config import Settings
from ..imaging import ImageError, prepare_image
from ..schemas import ID_PATTERN
from ..voice import ElevenLabsVoice, VoiceError
from .brain import Brain, BrainError, Prompt, PromptFrame, build_system_prompt
from .render import render
from .sessions import Session, SessionExpired, SessionNotFound, SessionStore, Turn

log = logging.getLogger("gem.assistant")

AUDIO_MIME = {"audio/wav", "audio/x-wav", "audio/mp3", "audio/mpeg", "audio/aac", "audio/ogg", "audio/flac", "audio/mp4"}


def _error(status: int, code: str, message: str, **extra: Any) -> JSONResponse:
    return JSONResponse(status_code=status, content=jsonable_encoder({"error": code, "message": message, **extra}))


# -- models --------------------------------------------------------------------


class SessionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    patient_id: str = Field(default="patient-demo-001", pattern=ID_PATTERN)


class SessionOut(BaseModel):
    session_id: str
    idle_timeout_s: float
    memory_s: float
    expires_in_s: float
    frame_interval_ms: int
    frames_buffered: int
    frames_received: int
    turns: int
    study_context: bool


class FrameIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    image_base64: str = Field(min_length=1, max_length=4_000_000)


class FrameOut(BaseModel):
    frames_buffered: int = Field(description="Frames in Gem's visual memory")
    frames_received: int
    kept: bool = Field(description="False when the scene had not changed since the last kept frame")
    change_score: float | None = Field(description="0 = identical to previous frame, 1 = completely different")
    expires_in_s: float


class TurnIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    audio_base64: str | None = Field(default=None, max_length=6_000_000)
    audio_mime: str | None = None
    text: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def _one_input(self) -> TurnIn:
        if (self.audio_base64 is None) == (self.text is None):
            raise ValueError("send exactly one of audio_base64 or text")
        if self.text is not None and not self.text.strip():
            raise ValueError("text is empty")
        if self.audio_base64 is not None and (self.audio_mime or "audio/wav") not in AUDIO_MIME:
            raise ValueError(f"audio_mime must be one of {sorted(AUDIO_MIME)}")
        return self


class AnnotationOut(BaseModel):
    label: str
    box_2d: list[int]


class TurnOut(BaseModel):
    turn_id: str
    status: Literal["answered", "ignored"]
    transcript: str
    answer: str
    annotations: list[AnnotationOut]
    image_url: str | None
    image_width: int
    image_height: int
    frame_id: int | None = Field(description="Memory frame the image shows / the boxes are on")
    frame_age_s: float | None = Field(description="How long before the question that frame was taken")
    audio_url: str | None
    frames_used: int
    latency_ms: float


# -- router --------------------------------------------------------------------


def build_router(
    settings: Settings,
    store: SessionStore,
    brain: Brain,
    voice: ElevenLabsVoice | None,
    study_context: Callable[[], str | None],
) -> APIRouter:
    router = APIRouter(prefix="/sessions", tags=["assistant"])

    def load(session_id: str) -> Session | JSONResponse:
        try:
            return store.get(session_id)
        except SessionExpired:
            return _error(410, "session_expired", "This session timed out. Start a new one.")
        except SessionNotFound:
            return _error(404, "session_not_found", f"No session {session_id}.")

    def session_out(s: Session) -> SessionOut:
        return SessionOut(
            session_id=s.session_id,
            idle_timeout_s=store.idle_timeout_s,
            memory_s=store.memory_s,
            expires_in_s=round(store.expires_in(s), 1),
            frame_interval_ms=1000,
            frames_buffered=len(store.memory(s)),
            frames_received=s.frames_received,
            turns=len(s.turns),
            study_context=bool(s.study_context),
        )

    @router.post("", status_code=201, response_model=SessionOut)
    def create_session(body: SessionCreate | None = None) -> SessionOut:
        body = body or SessionCreate()
        return session_out(store.create(body.patient_id, study_context()))

    @router.get("/{session_id}", response_model=SessionOut)
    def get_session(session_id: str) -> Any:
        s = load(session_id)
        return s if isinstance(s, JSONResponse) else session_out(s)

    @router.delete("/{session_id}", status_code=204)
    def end_session(session_id: str) -> Response:
        if not store.end(session_id):
            return _error(404, "session_not_found", f"No session {session_id}.")
        return Response(status_code=204)

    @router.post("/{session_id}/frames", response_model=FrameOut)
    def add_frame(session_id: str, body: FrameIn) -> Any:
        s = load(session_id)
        if isinstance(s, JSONResponse):
            return s
        try:
            img = prepare_image(body.image_base64, max_bytes=3_000_000, long_edge=settings.frame_long_edge)
        except ImageError as exc:
            return _error(422, "bad_image", str(exc))
        score, kept = store.add_frame(s, img.jpeg, img.width, img.height, img.mean_luma)
        return FrameOut(
            frames_buffered=len(s.frames),
            frames_received=s.frames_received,
            kept=kept,
            change_score=score,
            expires_in_s=round(store.expires_in(s), 1),
        )

    @router.post("/{session_id}/turns", response_model=TurnOut)
    async def add_turn(session_id: str, body: TurnIn) -> Any:
        s = load(session_id)
        if isinstance(s, JSONResponse):
            return s
        if s.turn_lock.locked():
            return _error(409, "turn_in_progress", "Gem is still answering the previous question.")
        audio: bytes | None = None
        if body.audio_base64 is not None:
            try:
                audio = base64.b64decode(body.audio_base64, validate=True)
            except (binascii.Error, ValueError):
                return _error(422, "bad_audio", "audio_base64 is not valid base64")
            if not audio or len(audio) > settings.max_audio_bytes:
                return _error(422, "bad_audio", f"audio must be 1..{settings.max_audio_bytes} bytes")

        async with s.turn_lock:
            store.touch(s)  # a prompt counts as activity
            asked_at = store.now()
            frames = store.memory(s)  # the whole visual memory, oldest first
            n_high = settings.high_res_recent_frames
            prompt = Prompt(
                system_prompt=build_system_prompt(s.study_context),
                history=s.history[-2 * settings.max_history_turns:],
                frames=[
                    PromptFrame(f.frame_id, round(asked_at - f.received_at, 1), f.jpeg, i >= len(frames) - n_high)
                    for i, f in enumerate(frames)
                ],
                audio=audio,
                audio_mime=(body.audio_mime or "audio/wav") if audio is not None else None,
                text=body.text.strip() if body.text is not None else None,
            )
            started = time.perf_counter()
            try:
                reply = await brain.reply(prompt)
            except BrainError as exc:
                log.info("turn failed in session %s: %s", session_id, exc)
                status = 504 if exc.code == "ai_timeout" else 502
                return _error(status, exc.code, "Gem couldn't answer that. Please try again.",
                              voice_line_id="network_error")
            latency_ms = round((time.perf_counter() - started) * 1000, 1)
            store.touch(s)

            turn_id = str(uuid.uuid4())
            if not reply.is_request:
                return TurnOut(turn_id=turn_id, status="ignored", transcript=reply.transcript, answer="",
                               annotations=[], image_url=None, image_width=0, image_height=0,
                               frame_id=None, frame_age_s=None,
                               audio_url=None, frames_used=len(frames), latency_ms=latency_ms)

            image_jpeg, w, h = (None, 0, 0)
            shown = next((f for f in frames if f.frame_id == reply.frame_id), frames[-1] if frames else None)
            if shown is not None:
                image_jpeg, w, h = await asyncio.to_thread(render, shown.jpeg, reply.annotations)

            s.history.append({"role": "user", "text": reply.transcript or (body.text or "")})
            marked = (
                f" [Marked on frame {shown.frame_id}: {', '.join(a.label for a in reply.annotations)}]"
                if reply.annotations and shown is not None else ""
            )
            s.history.append({"role": "model", "text": reply.answer + marked})
            del s.history[: max(0, len(s.history) - 2 * settings.max_history_turns)]

            store.add_turn(s, Turn(
                turn_id=turn_id, status="answered", transcript=reply.transcript, answer=reply.answer,
                annotations=[a.as_dict() for a in reply.annotations], image_jpeg=image_jpeg,
                image_width=w, image_height=h, created_at=store.now(),
            ))
            base = f"/sessions/{session_id}/turns/{turn_id}"
            return TurnOut(
                turn_id=turn_id, status="answered", transcript=reply.transcript, answer=reply.answer,
                annotations=[AnnotationOut(**a.as_dict()) for a in reply.annotations],
                image_url=f"{base}/image" if image_jpeg else None, image_width=w, image_height=h,
                frame_id=shown.frame_id if shown else None,
                frame_age_s=round(asked_at - shown.received_at, 1) if shown else None,
                audio_url=f"{base}/speech" if voice is not None else None,
                frames_used=len(frames), latency_ms=latency_ms,
            )

    def load_turn(session_id: str, turn_id: str) -> Turn | JSONResponse:
        s = load(session_id)
        if isinstance(s, JSONResponse):
            return s
        turn = s.turns.get(turn_id)
        if turn is None:
            return _error(404, "turn_not_found", f"No turn {turn_id}.")
        return turn

    @router.get("/{session_id}/turns/{turn_id}/image")
    def turn_image(session_id: str, turn_id: str) -> Any:
        turn = load_turn(session_id, turn_id)
        if isinstance(turn, JSONResponse):
            return turn
        if turn.image_jpeg is None:
            return _error(404, "no_image", "This answer has no image.")
        return Response(turn.image_jpeg, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=600"})

    @router.get("/{session_id}/turns/{turn_id}/speech")
    async def turn_speech(session_id: str, turn_id: str) -> Any:
        """ElevenLabs audio for an answer. Synthesized at most once per turn: the first
        request streams it through while caching it in RAM; later requests (replays)
        are served from the cache with no ElevenLabs call."""
        if voice is None:
            return _error(404, "voice_disabled", "ElevenLabs is not configured; use on-device speech.")
        turn = load_turn(session_id, turn_id)
        if isinstance(turn, JSONResponse):
            return turn
        if turn.audio is None and turn.audio_ready is not None:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(turn.audio_ready.wait(), timeout=30)
        if turn.audio is not None:
            return Response(turn.audio, media_type="audio/mpeg", headers={"X-Gem-Audio-Cache": "hit"})

        turn.audio_ready = asyncio.Event()
        try:
            stream = await voice.open_stream(turn.answer)
        except VoiceError as exc:
            turn.audio_ready.set()
            turn.audio_ready = None
            log.warning("voice failed for turn %s: %s", turn_id, exc)
            return _error(502, "voice_unavailable", "Speech synthesis failed.")

        async def tee() -> AsyncIterator[bytes]:
            chunks: list[bytes] = []
            complete = False
            try:
                async for chunk in stream:
                    chunks.append(chunk)
                    yield chunk
                complete = True
            finally:
                if complete:
                    turn.audio = b"".join(chunks)
                if turn.audio_ready is not None:
                    turn.audio_ready.set()
                    turn.audio_ready = None

        return StreamingResponse(tee(), media_type="audio/mpeg",
                                 headers={"Cache-Control": "no-store", "X-Gem-Audio-Cache": "miss"})

    return router


async def sweep_forever(store: SessionStore, interval_s: float) -> None:
    while True:
        await asyncio.sleep(interval_s)
        purged = store.sweep()
        if purged:
            log.info("purged %d idle assistant session(s)", purged)


