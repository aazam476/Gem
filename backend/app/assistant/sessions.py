"""The assistant's "context window": one in-memory session per open app.

Gemini has no API that accepts images into a persistent context without generating a
response for each one (see docs/ASSISTANT_SPEC.md §2), so the context lives here:
- a rolling buffer of the most recent camera frames (1 per second from the phone),
- the text history of the conversation (what the user said, what Gem answered),
- the rendered images and synthesized audio of recent answers (RAM cache).
Each prompt sends the newest frames + history to Gemini.

A session is purged after ``idle_timeout_s`` with neither a frame nor a prompt.
Nothing here is written to disk.
"""

from __future__ import annotations

import asyncio
import io
import time
import uuid
from collections import OrderedDict, deque
from collections.abc import Callable
from dataclasses import dataclass, field

from PIL import Image, ImageChops, ImageStat

Clock = Callable[[], float]
THUMB_SIZE = (32, 32)


@dataclass
class Frame:
    jpeg: bytes
    width: int
    height: int
    received_at: float
    mean_luma: float


@dataclass
class Turn:
    turn_id: str
    status: str
    transcript: str
    answer: str
    annotations: list[dict]
    image_jpeg: bytes | None
    image_width: int
    image_height: int
    created_at: float
    audio: bytes | None = None
    audio_ready: asyncio.Event | None = None  # set while a first synthesis is streaming


@dataclass
class Session:
    session_id: str
    patient_id: str
    study_context: str | None
    created_at: float
    last_activity: float
    frames: deque[Frame]
    history: list[dict[str, str]] = field(default_factory=list)  # [{"role": "user"|"model", "text": ...}]
    turns: OrderedDict[str, Turn] = field(default_factory=OrderedDict)
    last_thumb: Image.Image | None = None
    last_change_score: float | None = None
    frames_received: int = 0
    turn_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


def change_score(previous: Image.Image | None, current: Image.Image) -> float | None:
    """Mean absolute difference of 32x32 grayscale thumbnails, 0 (same) .. 1 (inverted)."""
    if previous is None:
        return None
    diff = ImageChops.difference(previous, current)
    return round(ImageStat.Stat(diff).mean[0] / 255.0, 4)


def thumbnail(jpeg: bytes) -> Image.Image:
    with Image.open(io.BytesIO(jpeg)) as img:
        return img.convert("L").resize(THUMB_SIZE, Image.Resampling.BILINEAR)


class SessionExpired(Exception):
    pass


class SessionNotFound(Exception):
    pass


class SessionStore:
    def __init__(
        self,
        *,
        idle_timeout_s: float,
        max_frames: int,
        max_turns_kept: int = 10,
        clock: Clock = time.monotonic,
    ) -> None:
        self.idle_timeout_s = idle_timeout_s
        self.max_frames = max_frames
        self.max_turns_kept = max_turns_kept
        self._clock = clock
        self._sessions: dict[str, Session] = {}
        self._expired: deque[str] = deque(maxlen=5000)  # tombstones -> 410 instead of 404

    def now(self) -> float:
        return self._clock()

    def create(self, patient_id: str, study_context: str | None) -> Session:
        self.sweep()
        now = self.now()
        session = Session(
            session_id=str(uuid.uuid4()),
            patient_id=patient_id,
            study_context=study_context,
            created_at=now,
            last_activity=now,
            frames=deque(maxlen=self.max_frames),
        )
        self._sessions[session.session_id] = session
        return session

    def get(self, session_id: str) -> Session:
        session = self._sessions.get(session_id)
        if session is None:
            if session_id in self._expired:
                raise SessionExpired(session_id)
            raise SessionNotFound(session_id)
        if self.now() - session.last_activity > self.idle_timeout_s:
            self._purge(session_id)
            raise SessionExpired(session_id)
        return session

    def touch(self, session: Session) -> None:
        session.last_activity = self.now()

    def expires_in(self, session: Session) -> float:
        return max(0.0, self.idle_timeout_s - (self.now() - session.last_activity))

    def add_frame(self, session: Session, frame: Frame) -> float | None:
        thumb = thumbnail(frame.jpeg)
        score = change_score(session.last_thumb, thumb)
        session.last_thumb = thumb
        session.last_change_score = score
        session.frames.append(frame)
        session.frames_received += 1
        self.touch(session)
        return score

    def add_turn(self, session: Session, turn: Turn) -> None:
        session.turns[turn.turn_id] = turn
        while len(session.turns) > self.max_turns_kept:
            session.turns.popitem(last=False)

    def end(self, session_id: str) -> bool:
        if session_id in self._sessions:
            self._purge(session_id)
            return True
        return False

    def _purge(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)
        self._expired.append(session_id)

    def sweep(self) -> int:
        """Purge every idle session. Returns how many were purged."""
        now = self.now()
        stale = [sid for sid, s in self._sessions.items() if now - s.last_activity > self.idle_timeout_s]
        for sid in stale:
            self._purge(sid)
        return len(stale)

    def __len__(self) -> int:
        return len(self._sessions)
