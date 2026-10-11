"""Runtime settings, read once from the environment (and backend/.env if present)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _float(name: str, default: float) -> float:
    raw = os.getenv(name)
    return float(raw) if raw else default


def _list(name: str, default: list[str]) -> list[str]:
    raw = os.getenv(name)
    if not raw:
        return default
    return [item.strip() for item in raw.split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    database_path: str = str(BACKEND_DIR / "gem.db")

    # AI providers. Keys live only here (backend), never in the mobile bundle.
    gemini_api_key: str = ""
    gemini_model: str = "gemini-3.6-flash"
    gemini_thinking_level: str = "low"
    elevenlabs_api_key: str = ""
    elevenlabs_voice_id: str = "21m00Tcm4TlvDq8ikWAM"
    elevenlabs_model_id: str = "eleven_flash_v2_5"

    # Offline / demo mode: deterministic fake Gemini, no ElevenLabs calls.
    mock_ai: bool = False
    mock_readings: str = '{"systolic": 128, "diastolic": 82, "pulse": 71}'

    # Per-stage latency budgets (seconds).
    ai_timeout_s: float = 8.0
    voice_connect_timeout_s: float = 3.0

    # Images: server-side guardrails (the app already downsizes before upload).
    max_image_bytes: int = 6_000_000
    max_image_long_edge: int = 1024

    capture_ttl_s: float = 600.0

    # Gem assistant (camera + voice). See docs/ASSISTANT_SPEC.md.
    assistant_model: str = "gemini-3.8-flash"
    assistant_timeout_s: float = 20.0
    session_idle_timeout_s: float = 600.0  # purge a context window after 10 min without frames or prompts
    # Visual memory: frames that differ from the last kept one (plus one every
    # frame_keepalive_s) are kept for memory_s seconds and ALL of them go to Gemini with
    # each question, so Gem can point at something it saw minutes ago.
    memory_s: float = 300.0
    session_max_frames: int = 300          # hard cap on kept frames per session
    frame_dedupe_threshold: float = 0.02   # change_score below this = same scene, not kept
    frame_keepalive_s: float = 30.0        # keep one frame this often even if nothing changes
    high_res_recent_frames: int = 2        # newest frames sent at high resolution, rest low
    frame_long_edge: int = 768
    max_history_turns: int = 20
    max_audio_bytes: int = 4_000_000
    cors_origins: list[str] = field(
        default_factory=lambda: ["http://localhost:8081", "http://localhost:19006"]
    )
    # Optional shared secret for direct POST /ingest_vitals calls. Empty = open (dev).
    gateway_token: str = ""

    @property
    def voice_enabled(self) -> bool:
        return bool(self.elevenlabs_api_key) and not self.mock_ai


def load_settings(**overrides: object) -> Settings:
    load_dotenv(BACKEND_DIR / ".env", override=False)
    values: dict[str, object] = dict(
        database_path=os.getenv("GEM_DATABASE_PATH", str(BACKEND_DIR / "gem.db")),
        gemini_api_key=os.getenv("GEMINI_API_KEY", ""),
        gemini_model=os.getenv("GEMINI_MODEL", "gemini-3.6-flash"),
        gemini_thinking_level=os.getenv("GEMINI_THINKING_LEVEL", "low"),
        elevenlabs_api_key=os.getenv("ELEVENLABS_API_KEY", ""),
        elevenlabs_voice_id=os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM"),
        elevenlabs_model_id=os.getenv("ELEVENLABS_MODEL_ID", "eleven_flash_v2_5"),
        mock_ai=_bool("GEM_MOCK_AI", False),
        mock_readings=os.getenv(
            "GEM_MOCK_READINGS", '{"systolic": 128, "diastolic": 82, "pulse": 71}'
        ),
        ai_timeout_s=_float("GEM_AI_TIMEOUT_S", 8.0),
        capture_ttl_s=_float("GEM_CAPTURE_TTL_S", 600.0),
        assistant_model=os.getenv("GEMINI_ASSISTANT_MODEL", "gemini-3.8-flash"),
        assistant_timeout_s=_float("GEM_ASSISTANT_TIMEOUT_S", 20.0),
        session_idle_timeout_s=_float("GEM_SESSION_IDLE_TIMEOUT_S", 600.0),
        memory_s=_float("GEM_MEMORY_S", 300.0),
        session_max_frames=int(_float("GEM_SESSION_MAX_FRAMES", 300)),
        frame_dedupe_threshold=_float("GEM_FRAME_DEDUPE_THRESHOLD", 0.02),
        frame_keepalive_s=_float("GEM_FRAME_KEEPALIVE_S", 30.0),
        high_res_recent_frames=int(_float("GEM_HIGH_RES_RECENT_FRAMES", 2)),
        cors_origins=_list(
            "GEM_CORS_ORIGINS", ["http://localhost:8081", "http://localhost:19006"]
        ),
        gateway_token=os.getenv("GEM_GATEWAY_TOKEN", ""),
    )
    values.update(overrides)
    return Settings(**values)  # type: ignore[arg-type]
