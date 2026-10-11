"""FastAPI application: portal API, capture pipeline, and the deterministic gateway.

Request flow for one capture (see docs/SPEC.md §3):
  app -> POST /captures (image) -> Gemini (untrusted) -> strict parse -> gateway dry-run
      -> response with box + read-back voice script (+ audio_url)
  app -> POST /captures/{id}/confirm -> gateway (server-held readings) -> clinical_events
The phone never submits vitals values itself.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

from fastapi import FastAPI, Header, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from .assistant.brain import Brain, make_brain
from .assistant.routes import build_router, sweep_forever
from .assistant.sessions import SessionStore
from .config import Settings, load_settings
from .imaging import ImageError, prepare_image
from .ingest import IngestResult, ingest, timed_evaluate
from .metrics import LatencyRecorder
from .rules import ValidationRules, blood_pressure_preset
from .schemas import (
    CaptureCreate,
    CaptureOut,
    ConfirmRequest,
    HealthOut,
    IngestRequest,
    IngestResponse,
    ProtocolCreate,
    ProtocolOut,
)
from .store import CachedProtocol, Store, now_iso
from .vision import MockVision, VisionClient, VisionError, make_vision
from .voice import ElevenLabsVoice, VoiceError
from .voice_lines import VOICE_LINES, readback

log = logging.getLogger("gem")


def error(status: int, code: str, message: str, **extra: Any) -> JSONResponse:
    body = {"error": code, "message": message, **extra}
    return JSONResponse(status_code=status, content=jsonable_encoder(body))


def with_line(line_id: str) -> dict[str, str]:
    return {"voice_line_id": line_id, "voice_script": VOICE_LINES[line_id]}


def ingest_response(result: IngestResult) -> JSONResponse:
    if result.kind == "created":
        assert result.event is not None
        line = "saved_flagged" if result.event["status"] == "flagged" else "saved"
        body = IngestResponse(
            result=result.event["status"],
            event=result.event,
            validation_ns=result.validation_ns,
            **with_line(line),
        )
        return JSONResponse(status_code=201, content=jsonable_encoder(body))
    if result.kind == "duplicate":
        return error(409, "duplicate", "This submission was already recorded.",
                     event=result.event, **with_line("already_saved"))
    if result.kind == "conflict":
        return error(409, "idempotency_conflict",
                     "This idempotency key was already used for a different payload.",
                     event=result.event)
    assert result.verdict is not None
    return error(422, "rejected", "Readings failed deterministic validation.",
                 errors=[e.as_dict() for e in result.verdict.errors],
                 validation_ns=result.validation_ns, **with_line("retake_unusual"))


def create_app(
    settings: Settings | None = None,
    *,
    vision: VisionClient | None = None,
    voice: ElevenLabsVoice | None = None,
    brain: Brain | None = None,
    session_store: SessionStore | None = None,
) -> FastAPI:
    settings = settings or load_settings()
    store = Store(settings.database_path)
    recorder = LatencyRecorder()
    vision_client = vision or make_vision(settings)
    voice_client = voice or (ElevenLabsVoice(settings) if settings.voice_enabled else None)
    ai_mode = "mock" if isinstance(vision_client, MockVision) else "gemini"
    if ai_mode == "mock" and not settings.mock_ai:
        log.warning("GEMINI_API_KEY is not set: using the mock vision model.")

    sessions = session_store if session_store is not None else SessionStore(
        idle_timeout_s=settings.session_idle_timeout_s,
        max_frames=settings.session_max_frames,
        memory_s=settings.memory_s,
        dedupe_threshold=settings.frame_dedupe_threshold,
        keepalive_s=settings.frame_keepalive_s,
    )
    brain_client = brain or make_brain(settings)

    def study_context() -> str | None:
        # Until researcher uploads exist (TASKS phase 9), the active protocol's
        # instructions are the study context Gem receives.
        active = store.active_protocol()
        return f"{active.title}: {active.prompt_text}" if active else None

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        sweeper = asyncio.create_task(sweep_forever(sessions, min(30.0, settings.session_idle_timeout_s / 4)))
        yield
        sweeper.cancel()
        store.close()

    app = FastAPI(title="Gem API", version="1.0.0", lifespan=lifespan)
    app.state.store = store
    app.state.recorder = recorder
    app.state.settings = settings
    app.state.sessions = sessions
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["Content-Type", "X-Gateway-Token"],
    )

    @app.exception_handler(RequestValidationError)
    async def malformed(_: Request, exc: RequestValidationError) -> JSONResponse:
        details = [
            {"code": "malformed", "metric": ".".join(str(p) for p in e.get("loc", ())), "message": e.get("msg", "")}
            for e in exc.errors()
        ]
        return error(422, "malformed", "Request body failed schema validation.", errors=details)

    def resolve_protocol(protocol_id: str) -> CachedProtocol | JSONResponse:
        protocol = store.get_protocol(protocol_id)
        if protocol is None:
            return error(404, "protocol_not_found", f"No protocol {protocol_id}.")
        if not protocol.is_active:
            return error(409, "protocol_inactive", "This protocol is not active.")
        return protocol

    # -- meta --------------------------------------------------------------------

    @app.get("/health", response_model=HealthOut)
    def health() -> HealthOut:
        active = store.active_protocol()
        return HealthOut(
            status="ok", ai_mode=ai_mode, voice_enabled=voice_client is not None,
            gemini_model=settings.gemini_model,
            active_protocol_id=active.protocol_id if active else None,
        )

    @app.get("/presets/blood_pressure", response_model=ValidationRules)
    def bp_preset() -> ValidationRules:
        return blood_pressure_preset()

    # -- protocols (researcher portal) -------------------------------------------

    @app.post("/protocols", status_code=201, response_model=ProtocolOut)
    def create_protocol(body: ProtocolCreate) -> dict[str, Any]:
        protocol = store.create_protocol(
            body.title.strip(), body.prompt_text.strip(), body.validation_rules, body.activate
        )
        return protocol.public()

    @app.get("/protocols", response_model=list[ProtocolOut])
    def list_protocols() -> list[dict[str, Any]]:
        return [p.public() for p in store.list_protocols()]

    @app.get("/protocols/active", response_model=ProtocolOut)
    def active_protocol() -> Any:
        protocol = store.active_protocol()
        if protocol is None:
            return error(404, "no_active_protocol", "No protocol is deployed yet.")
        return protocol.public()

    @app.get("/protocols/{protocol_id}", response_model=ProtocolOut)
    def get_protocol(protocol_id: str) -> Any:
        protocol = store.get_protocol(protocol_id)
        if protocol is None:
            return error(404, "protocol_not_found", f"No protocol {protocol_id}.")
        return protocol.public()

    @app.post("/protocols/{protocol_id}/activate", response_model=ProtocolOut)
    def activate(protocol_id: str) -> Any:
        protocol = store.set_active(protocol_id, True)
        if protocol is None:
            return error(404, "protocol_not_found", f"No protocol {protocol_id}.")
        return protocol.public()

    @app.post("/protocols/{protocol_id}/deactivate", response_model=ProtocolOut)
    def deactivate(protocol_id: str) -> Any:
        protocol = store.set_active(protocol_id, False)
        if protocol is None:
            return error(404, "protocol_not_found", f"No protocol {protocol_id}.")
        return protocol.public()

    # -- gateway -----------------------------------------------------------------

    @app.post("/ingest_vitals", status_code=201, response_model=IngestResponse)
    def ingest_vitals(
        body: IngestRequest, x_gateway_token: str | None = Header(default=None)
    ) -> JSONResponse:
        if settings.gateway_token and x_gateway_token != settings.gateway_token:
            return error(401, "unauthorized", "Missing or wrong X-Gateway-Token.")
        protocol = resolve_protocol(body.protocol_id)
        if isinstance(protocol, JSONResponse):
            return protocol
        result = ingest(
            store, recorder, protocol,
            patient_id=body.patient_id, session_id=body.session_id,
            idempotency_key=body.idempotency_key, readings=body.readings,
        )
        return ingest_response(result)

    @app.get("/events")
    def events(protocol_id: str | None = None, limit: int = Query(50, ge=1, le=500)) -> list[dict[str, Any]]:
        return store.list_events(protocol_id, limit)

    @app.get("/rejections")
    def rejections(protocol_id: str | None = None, limit: int = Query(50, ge=1, le=500)) -> list[dict[str, Any]]:
        return store.list_rejections(protocol_id, limit)

    @app.get("/metrics/gateway")
    def gateway_metrics() -> dict[str, Any]:
        return {"validation": recorder.summary(), "events_stored": store.count_events()}

    @app.post("/metrics/gateway/reset")
    def reset_metrics() -> dict[str, str]:
        recorder.reset()
        return {"status": "reset"}

    # -- capture pipeline (patient app) ------------------------------------------

    @app.post("/captures", response_model=CaptureOut)
    async def create_capture(body: CaptureCreate) -> Any:
        protocol = resolve_protocol(body.protocol_id)
        if isinstance(protocol, JSONResponse):
            return protocol
        try:
            image = prepare_image(
                body.image_base64,
                max_bytes=settings.max_image_bytes,
                long_edge=settings.max_image_long_edge,
            )
        except ImageError as exc:
            return error(422, "bad_image", str(exc))

        capture_id = str(uuid.uuid4())
        started = time.perf_counter()
        out: dict[str, Any] = {
            "capture_id": capture_id,
            "image_width": image.width,
            "image_height": image.height,
        }
        try:
            result = await vision_client.analyze(image, protocol.prompt_text, protocol.rules)
        except VisionError as exc:
            log.info("capture %s dropped: %s", capture_id, exc)
            line = "network_error" if exc.code in {"ai_timeout", "ai_error"} else "retake_unclear"
            out.update(status="unreadable", reason=exc.code, **with_line(line))
            result = None
        ai_latency_ms = round((time.perf_counter() - started) * 1000, 1)
        out["ai_latency_ms"] = ai_latency_ms

        readings: dict[str, float] = {}
        if result is not None:
            readings = {k: v for k, v in result.readings.items() if v is not None}
            if not result.found or not readings:
                script = result.voice_script or VOICE_LINES["retake_unclear"]
                out.update(status="unreadable", reason="no_display", voice_script=script,
                           voice_line_id=None if result.voice_script else "retake_unclear")
            else:
                verdict, elapsed = timed_evaluate(protocol, readings, recorder)
                out.update(bounding_box=result.bounding_box, readings=readings,
                           validation_ns=elapsed)
                if verdict.outcome == "rejected":
                    store.record_rejection(
                        protocol_id=protocol.protocol_id, patient_id=body.patient_id,
                        session_id=body.session_id, capture_id=capture_id,
                        idempotency_key=None, readings=readings, verdict=verdict,
                        validation_ns=elapsed,
                    )
                    out.update(status="rejected", reason="gateway_rejected",
                               errors=[e.as_dict() for e in verdict.errors],
                               **with_line("retake_unusual"))
                else:
                    out.update(status="needs_confirmation",
                               flags=[f.as_dict() for f in verdict.flags],
                               voice_script=readback(protocol.rules, verdict.values),
                               voice_line_id=None)

        store.insert_capture({
            "capture_id": capture_id,
            "protocol_id": protocol.protocol_id,
            "patient_id": body.patient_id,
            "session_id": body.session_id,
            "status": out["status"],
            "readings": readings or None,
            "bounding_box": out.get("bounding_box"),
            "voice_script": out["voice_script"],
            "ai_latency_ms": ai_latency_ms,
            "created_at": now_iso(),
        })
        if voice_client is not None:
            out["audio_url"] = f"/captures/{capture_id}/speech"
        return CaptureOut(**out)

    def load_capture(capture_id: str) -> dict[str, Any] | JSONResponse:
        capture = store.get_capture(capture_id)
        if capture is None:
            return error(404, "capture_not_found", f"No capture {capture_id}.")
        return capture

    @app.post("/captures/{capture_id}/confirm", status_code=201, response_model=IngestResponse)
    def confirm_capture(capture_id: str, body: ConfirmRequest) -> JSONResponse:
        capture = load_capture(capture_id)
        if isinstance(capture, JSONResponse):
            return capture
        if capture["status"] not in {"needs_confirmation", "confirmed"}:
            return error(409, "capture_not_confirmable",
                         f"Capture is '{capture['status']}', not awaiting confirmation.")
        protocol = store.get_protocol(capture["protocol_id"])
        if protocol is None:
            return error(404, "protocol_not_found", "Protocol was removed.")
        age_s = (datetime.now(UTC) - datetime.fromisoformat(capture["created_at"])).total_seconds()
        if capture["status"] == "needs_confirmation" and age_s > settings.capture_ttl_s:
            return error(410, "capture_expired", "This capture is too old; please retake.",
                         **with_line("retake_requested"))
        result = ingest(
            store, recorder, protocol,
            patient_id=capture["patient_id"], session_id=capture["session_id"],
            idempotency_key=body.idempotency_key, readings=capture["readings"] or {},
            capture_id=capture_id,
        )
        if result.kind == "created":
            store.set_capture_status(capture_id, "confirmed")
        return ingest_response(result)

    @app.post("/captures/{capture_id}/discard")
    def discard_capture(capture_id: str) -> Any:
        capture = load_capture(capture_id)
        if isinstance(capture, JSONResponse):
            return capture
        if capture["status"] == "confirmed":
            return error(409, "capture_not_confirmable", "Capture was already confirmed.")
        store.set_capture_status(capture_id, "discarded")
        return {"capture_id": capture_id, "status": "discarded", **with_line("retake_requested")}

    @app.get("/captures/{capture_id}/speech")
    async def capture_speech(capture_id: str) -> Any:
        if voice_client is None:
            return error(404, "voice_disabled", "ElevenLabs is not configured; use on-device speech.")
        capture = load_capture(capture_id)
        if isinstance(capture, JSONResponse):
            return capture
        try:
            stream = await voice_client.open_stream(capture["voice_script"])
        except VoiceError as exc:
            log.warning("voice failed for %s: %s", capture_id, exc)
            return error(502, "voice_unavailable", "Speech synthesis failed.")
        return StreamingResponse(stream, media_type="audio/mpeg",
                                 headers={"Cache-Control": "no-store"})

    app.include_router(build_router(settings, sessions, brain_client, voice_client, study_context))
    return app


def get_app() -> FastAPI:
    """Uvicorn factory: ``uvicorn app.main:get_app --factory``."""
    logging.basicConfig(level=logging.INFO)
    return create_app()
