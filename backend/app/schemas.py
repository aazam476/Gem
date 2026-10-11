"""HTTP request/response models (see docs/API_CONTRACT.md)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .rules import ValidationRules

ID_PATTERN = r"^[A-Za-z0-9_.:-]{1,128}$"


class ProtocolCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=120)
    prompt_text: str = Field(min_length=1, max_length=2000)
    validation_rules: ValidationRules
    activate: bool = True


class ProtocolOut(BaseModel):
    protocol_id: str
    title: str
    prompt_text: str
    validation_rules: ValidationRules
    is_active: bool
    created_at: str


class IngestRequest(BaseModel):
    """Direct gateway submission. ``readings`` is deliberately untyped: the gateway,
    not the HTTP layer, decides whether values are acceptable (and logs rejections)."""

    model_config = ConfigDict(extra="forbid")

    protocol_id: str = Field(pattern=ID_PATTERN)
    patient_id: str = Field(pattern=ID_PATTERN)
    session_id: str = Field(pattern=ID_PATTERN)
    idempotency_key: str = Field(pattern=ID_PATTERN)
    readings: dict[str, Any]


class Issue(BaseModel):
    code: str
    metric: str | None
    message: str


class EventOut(BaseModel):
    event_id: str
    protocol_id: str
    patient_id: str
    session_id: str
    capture_id: str | None
    idempotency_key: str
    status: Literal["accepted", "flagged"]
    extracted_data: dict[str, float]
    flags: list[Issue]
    validation_ns: int
    timestamp: str


class IngestResponse(BaseModel):
    result: Literal["accepted", "flagged"]
    event: EventOut
    validation_ns: int
    voice_line_id: Literal["saved", "saved_flagged"]
    voice_script: str


class ErrorBody(BaseModel):
    error: str
    message: str
    errors: list[Issue] = []
    event: EventOut | None = None
    voice_line_id: str | None = None
    voice_script: str | None = None


class CaptureCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    protocol_id: str = Field(pattern=ID_PATTERN)
    patient_id: str = Field(pattern=ID_PATTERN)
    session_id: str = Field(pattern=ID_PATTERN)
    image_base64: str = Field(min_length=1, max_length=9_000_000)


CaptureStatus = Literal["needs_confirmation", "unreadable", "rejected"]


class CaptureOut(BaseModel):
    capture_id: str
    status: CaptureStatus
    reason: str | None = Field(
        default=None, description="Why the frame was dropped: no_display | invalid_output | ai_timeout | ai_error | gateway_rejected"
    )
    bounding_box: list[int] | None = Field(default=None, description="[ymin, xmin, ymax, xmax], 0-1000")
    image_width: int
    image_height: int
    readings: dict[str, float] | None = None
    flags: list[Issue] = []
    errors: list[Issue] = []
    voice_line_id: str | None = Field(default=None, description="Set when voice_script is a fixed line")
    voice_script: str
    audio_url: str | None = Field(default=None, description="Streams ElevenLabs audio for voice_script")
    ai_latency_ms: float
    validation_ns: int | None = None


class ConfirmRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    idempotency_key: str = Field(pattern=ID_PATTERN)


class HealthOut(BaseModel):
    status: Literal["ok"]
    ai_mode: Literal["gemini", "mock"]
    voice_enabled: bool
    gemini_model: str
    active_protocol_id: str | None
