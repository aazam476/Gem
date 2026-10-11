"""SQLite persistence + in-memory rule cache.

One connection guarded by a lock keeps writes serialized; the UNIQUE constraints on
``clinical_events.idempotency_key`` and ``clinical_events.capture_id`` are what make
duplicate (including concurrent duplicate) submissions count exactly once.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from .gateway import CompiledRules, Verdict, compile_rules
from .rules import ValidationRules

SCHEMA = """
CREATE TABLE IF NOT EXISTS protocols (
    protocol_id      TEXT PRIMARY KEY,
    title            TEXT NOT NULL,
    prompt_text      TEXT NOT NULL,
    validation_rules TEXT NOT NULL,
    is_active        INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS captures (
    capture_id    TEXT PRIMARY KEY,
    protocol_id   TEXT NOT NULL REFERENCES protocols(protocol_id),
    patient_id    TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    status        TEXT NOT NULL,
    readings      TEXT,
    bounding_box  TEXT,
    voice_script  TEXT NOT NULL,
    ai_latency_ms REAL,
    created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clinical_events (
    event_id        TEXT PRIMARY KEY,
    protocol_id     TEXT NOT NULL REFERENCES protocols(protocol_id),
    patient_id      TEXT NOT NULL,
    session_id      TEXT NOT NULL,
    capture_id      TEXT UNIQUE REFERENCES captures(capture_id),
    idempotency_key TEXT NOT NULL UNIQUE,
    request_hash    TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('accepted', 'flagged')),
    extracted_data  TEXT NOT NULL,
    flags           TEXT NOT NULL,
    validation_ns   INTEGER NOT NULL,
    timestamp       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gateway_rejections (
    rejection_id    TEXT PRIMARY KEY,
    protocol_id     TEXT NOT NULL,
    patient_id      TEXT NOT NULL,
    session_id      TEXT NOT NULL,
    capture_id      TEXT,
    idempotency_key TEXT,
    readings        TEXT NOT NULL,
    errors          TEXT NOT NULL,
    validation_ns   INTEGER NOT NULL,
    timestamp       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_protocol ON clinical_events(protocol_id, timestamp);
"""


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="microseconds")


def request_hash(protocol_id: str, patient_id: str, readings: Any) -> str:
    canonical = json.dumps(
        {"p": protocol_id, "u": patient_id, "r": readings}, sort_keys=True, default=str
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


@dataclass(frozen=True)
class CachedProtocol:
    protocol_id: str
    title: str
    prompt_text: str
    rules: ValidationRules
    compiled: CompiledRules
    is_active: bool
    created_at: str

    def public(self) -> dict[str, Any]:
        return {
            "protocol_id": self.protocol_id,
            "title": self.title,
            "prompt_text": self.prompt_text,
            "validation_rules": self.rules.model_dump(),
            "is_active": self.is_active,
            "created_at": self.created_at,
        }


class DuplicateEvent(Exception):
    def __init__(self, event: dict[str, Any], conflict: bool) -> None:
        super().__init__("duplicate submission")
        self.event = event
        self.conflict = conflict  # same key, different payload


class Store:
    def __init__(self, path: str) -> None:
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        if path != ":memory:":
            self._conn.execute("PRAGMA journal_mode = WAL")
            self._conn.execute("PRAGMA synchronous = NORMAL")
        self._conn.executescript(SCHEMA)
        self._protocols: dict[str, CachedProtocol] = {}
        self._reload_cache()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # -- protocols -------------------------------------------------------------

    def _reload_cache(self) -> None:
        rows = self._conn.execute("SELECT * FROM protocols").fetchall()
        cache = {}
        for row in rows:
            rules = ValidationRules.model_validate_json(row["validation_rules"])
            cache[row["protocol_id"]] = CachedProtocol(
                protocol_id=row["protocol_id"],
                title=row["title"],
                prompt_text=row["prompt_text"],
                rules=rules,
                compiled=compile_rules(rules),
                is_active=bool(row["is_active"]),
                created_at=row["created_at"],
            )
        self._protocols = cache

    def create_protocol(
        self, title: str, prompt_text: str, rules: ValidationRules, activate: bool
    ) -> CachedProtocol:
        protocol_id = str(uuid.uuid4())
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                if activate:
                    self._conn.execute("UPDATE protocols SET is_active = 0")
                self._conn.execute(
                    "INSERT INTO protocols VALUES (?, ?, ?, ?, ?, ?)",
                    (protocol_id, title, prompt_text, rules.model_dump_json(),
                     int(activate), now_iso()),
                )
                self._conn.execute("COMMIT")
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
            self._reload_cache()
            return self._protocols[protocol_id]

    def set_active(self, protocol_id: str, active: bool) -> CachedProtocol | None:
        with self._lock:
            if protocol_id not in self._protocols:
                return None
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                if active:  # exactly one active protocol at a time (MVP)
                    self._conn.execute("UPDATE protocols SET is_active = 0")
                self._conn.execute(
                    "UPDATE protocols SET is_active = ? WHERE protocol_id = ?",
                    (int(active), protocol_id),
                )
                self._conn.execute("COMMIT")
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
            self._reload_cache()
            return self._protocols[protocol_id]

    def get_protocol(self, protocol_id: str) -> CachedProtocol | None:
        return self._protocols.get(protocol_id)

    def list_protocols(self) -> list[CachedProtocol]:
        return sorted(self._protocols.values(), key=lambda p: p.created_at, reverse=True)

    def active_protocol(self) -> CachedProtocol | None:
        return next((p for p in self._protocols.values() if p.is_active), None)

    # -- captures --------------------------------------------------------------

    def insert_capture(self, capture: dict[str, Any]) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO captures VALUES (:capture_id, :protocol_id, :patient_id, :session_id,"
                " :status, :readings, :bounding_box, :voice_script, :ai_latency_ms, :created_at)",
                {
                    **capture,
                    "readings": json.dumps(capture.get("readings")),
                    "bounding_box": json.dumps(capture.get("bounding_box")),
                },
            )

    def get_capture(self, capture_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM captures WHERE capture_id = ?", (capture_id,)
            ).fetchone()
        if row is None:
            return None
        out = dict(row)
        out["readings"] = json.loads(out["readings"]) if out["readings"] else None
        out["bounding_box"] = json.loads(out["bounding_box"]) if out["bounding_box"] else None
        return out

    def set_capture_status(self, capture_id: str, status: str) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE captures SET status = ? WHERE capture_id = ?", (status, capture_id)
            )

    # -- events ----------------------------------------------------------------

    @staticmethod
    def _event_row(row: sqlite3.Row) -> dict[str, Any]:
        out = dict(row)
        out["extracted_data"] = json.loads(out["extracted_data"])
        out["flags"] = json.loads(out["flags"])
        out.pop("request_hash", None)
        return out

    def find_event(self, idempotency_key: str, capture_id: str | None) -> sqlite3.Row | None:
        row = self._conn.execute(
            "SELECT * FROM clinical_events WHERE idempotency_key = ?", (idempotency_key,)
        ).fetchone()
        if row is None and capture_id is not None:
            row = self._conn.execute(
                "SELECT * FROM clinical_events WHERE capture_id = ?", (capture_id,)
            ).fetchone()
        return row

    def record_event(
        self,
        *,
        protocol_id: str,
        patient_id: str,
        session_id: str,
        capture_id: str | None,
        idempotency_key: str,
        req_hash: str,
        verdict: Verdict,
        validation_ns: int,
    ) -> dict[str, Any]:
        """Insert an accepted/flagged event exactly once, or raise DuplicateEvent."""
        event = {
            "event_id": str(uuid.uuid4()),
            "protocol_id": protocol_id,
            "patient_id": patient_id,
            "session_id": session_id,
            "capture_id": capture_id,
            "idempotency_key": idempotency_key,
            "request_hash": req_hash,
            "status": verdict.outcome,
            "extracted_data": json.dumps(verdict.values, sort_keys=True),
            "flags": json.dumps([f.as_dict() for f in verdict.flags]),
            "validation_ns": validation_ns,
            "timestamp": now_iso(),
        }
        with self._lock:
            try:
                self._conn.execute(
                    "INSERT INTO clinical_events VALUES (:event_id, :protocol_id, :patient_id,"
                    " :session_id, :capture_id, :idempotency_key, :request_hash, :status,"
                    " :extracted_data, :flags, :validation_ns, :timestamp)",
                    event,
                )
            except sqlite3.IntegrityError:
                existing = self.find_event(idempotency_key, capture_id)
                if existing is None:
                    raise
                raise DuplicateEvent(
                    self._event_row(existing),
                    conflict=existing["request_hash"] != req_hash,
                ) from None
            row = self._conn.execute(
                "SELECT * FROM clinical_events WHERE event_id = ?", (event["event_id"],)
            ).fetchone()
        return self._event_row(row)

    def existing_event_with_hash(
        self, idempotency_key: str, capture_id: str | None
    ) -> tuple[dict[str, Any], str] | None:
        with self._lock:
            row = self.find_event(idempotency_key, capture_id)
        return (self._event_row(row), row["request_hash"]) if row is not None else None

    def record_rejection(
        self,
        *,
        protocol_id: str,
        patient_id: str,
        session_id: str,
        capture_id: str | None,
        idempotency_key: str | None,
        readings: Any,
        verdict: Verdict,
        validation_ns: int,
    ) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO gateway_rejections VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (str(uuid.uuid4()), protocol_id, patient_id, session_id, capture_id,
                 idempotency_key, json.dumps(readings, default=str),
                 json.dumps([e.as_dict() for e in verdict.errors]), validation_ns, now_iso()),
            )

    def list_events(self, protocol_id: str | None, limit: int) -> list[dict[str, Any]]:
        with self._lock:
            if protocol_id:
                rows = self._conn.execute(
                    "SELECT * FROM clinical_events WHERE protocol_id = ?"
                    " ORDER BY timestamp DESC LIMIT ?", (protocol_id, limit)
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT * FROM clinical_events ORDER BY timestamp DESC LIMIT ?", (limit,)
                ).fetchall()
        return [self._event_row(r) for r in rows]

    def list_rejections(self, protocol_id: str | None, limit: int) -> list[dict[str, Any]]:
        with self._lock:
            query = "SELECT * FROM gateway_rejections"
            args: tuple[Any, ...] = ()
            if protocol_id:
                query += " WHERE protocol_id = ?"
                args = (protocol_id,)
            rows = self._conn.execute(query + " ORDER BY timestamp DESC LIMIT ?", (*args, limit)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["readings"] = json.loads(d["readings"])
            d["errors"] = json.loads(d["errors"])
            out.append(d)
        return out

    def count_events(self) -> int:
        with self._lock:
            return self._conn.execute("SELECT COUNT(*) FROM clinical_events").fetchone()[0]
