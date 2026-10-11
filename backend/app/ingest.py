"""Gateway service: idempotency + timed deterministic validation + persistence.

This is the single path by which data reaches ``clinical_events``. Both the HTTP
endpoint ``POST /ingest_vitals`` and the capture-confirmation flow call ``ingest``.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Literal

from .gateway import Verdict, evaluate
from .metrics import LatencyRecorder
from .store import CachedProtocol, DuplicateEvent, Store, request_hash

IngestKind = Literal["created", "duplicate", "conflict", "rejected"]


@dataclass(frozen=True)
class IngestResult:
    kind: IngestKind
    event: dict[str, Any] | None
    verdict: Verdict | None
    validation_ns: int


def timed_evaluate(protocol: CachedProtocol, readings: Any, recorder: LatencyRecorder) -> tuple[Verdict, int]:
    start = time.perf_counter_ns()
    verdict = evaluate(protocol.compiled, readings)
    elapsed = time.perf_counter_ns() - start
    recorder.record(elapsed)
    return verdict, elapsed


def ingest(
    store: Store,
    recorder: LatencyRecorder,
    protocol: CachedProtocol,
    *,
    patient_id: str,
    session_id: str,
    idempotency_key: str,
    readings: Any,
    capture_id: str | None = None,
) -> IngestResult:
    req_hash = request_hash(protocol.protocol_id, patient_id, readings)

    # Fast path: a retry of something already recorded never re-validates.
    existing = store.existing_event_with_hash(idempotency_key, capture_id)
    if existing is not None:
        event, stored_hash = existing
        kind: IngestKind = "duplicate" if stored_hash == req_hash else "conflict"
        return IngestResult(kind, event, None, 0)

    verdict, elapsed = timed_evaluate(protocol, readings, recorder)

    if verdict.outcome == "rejected":
        store.record_rejection(
            protocol_id=protocol.protocol_id, patient_id=patient_id, session_id=session_id,
            capture_id=capture_id, idempotency_key=idempotency_key, readings=readings,
            verdict=verdict, validation_ns=elapsed,
        )
        return IngestResult("rejected", None, verdict, elapsed)

    try:
        event = store.record_event(
            protocol_id=protocol.protocol_id, patient_id=patient_id, session_id=session_id,
            capture_id=capture_id, idempotency_key=idempotency_key, req_hash=req_hash,
            verdict=verdict, validation_ns=elapsed,
        )
    except DuplicateEvent as dup:  # lost a race with a concurrent duplicate
        return IngestResult("conflict" if dup.conflict else "duplicate", dup.event, verdict, elapsed)
    return IngestResult("created", event, verdict, elapsed)
