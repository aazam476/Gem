"""The assistant's "context window": one in-memory session per open app.

Gemini has no API that accepts images into a persistent context without generating a
response for each one (see docs/ASSISTANT_SPEC.md §2), so the context lives here:
- Gem's visual memory: every frame that differs from the last kept one (the phone sends
  1 per second; unchanged scenes are skipped, but one frame is kept every keepalive
  period), for ``memory_s`` seconds. All of it is sent with each question so Gem can
  point at something it saw a minute ago,
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
    frame_id: int  # per session, increasing; Gemini refers to frames by this id
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
    last_thumb: Image.Image | None = None        # previous *received* frame (change score)
    last_kept_thumb: Image.Image | None = None   # previous *kept* frame (dedupe)
    last_kept_at: float | None = None
    last_change_score: float | None = None
    frames_received: int = 0
    next_frame_id: int = 1
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
        memory_s: float = 300.0,
        dedupe_threshold: float = 0.02,
        keepalive_s: float = 30.0,
        max_turns_kept: int = 10,
        clock: Clock = time.monotonic,
    ) -> None:
        self.idle_timeout_s = idle_timeout_s
        self.max_frames = max_frames
        self.memory_s = memory_s
        self.dedupe_threshold = dedupe_threshold
        self.keepalive_s = keepalive_s
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

    def add_frame(self, session: Session, jpeg: bytes, width: int, height: int, mean_luma: float) -> tuple[float | None, bool]:
        """Record a received frame. Returns (change vs previous frame, whether it was kept in memory)."""
        now = self.now()
        thumb = thumbnail(jpeg)
        score = change_score(session.last_thumb, thumb)
        session.last_thumb = thumb
        session.last_change_score = score
        session.frames_received += 1
        self.touch(session)

        vs_kept = change_score(session.last_kept_thumb, thumb)
        stale = session.last_kept_at is None or now - session.last_kept_at >= self.keepalive_s
        keep = vs_kept is None or vs_kept >= self.dedupe_threshold or stale
        if keep:
            session.frames.append(Frame(session.next_frame_id, jpeg, width, height, now, mean_luma))
            session.next_frame_id += 1
            session.last_kept_thumb = thumb
            session.last_kept_at = now
        self.forget_old_frames(session)
        return score, keep

    def forget_old_frames(self, session: Session) -> None:
        cutoff = self.now() - self.memory_s
        while session.frames and session.frames[0].received_at < cutoff:
            session.frames.popleft()

    def memory(self, session: Session) -> list[Frame]:
        """Frames Gem can see for the next question, oldest first."""
        self.forget_old_frames(session)
        return list(session.frames)

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
