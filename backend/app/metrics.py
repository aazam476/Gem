"""Latency recording for the deterministic gateway (validation-only time)."""

from __future__ import annotations

import math
import threading
from collections import deque


def percentile(sorted_values: list[float], pct: float) -> float:
    """Nearest-rank percentile of an already-sorted list."""
    if not sorted_values:
        return 0.0
    rank = max(1, math.ceil(pct / 100 * len(sorted_values)))
    return sorted_values[rank - 1]


def summarize_ns(samples: list[int]) -> dict[str, float | int]:
    ordered = sorted(samples)
    us = [v / 1000 for v in ordered]
    return {
        "count": len(us),
        "p50_us": round(percentile(us, 50), 3),
        "p95_us": round(percentile(us, 95), 3),
        "p99_us": round(percentile(us, 99), 3),
        "max_us": round(us[-1], 3) if us else 0.0,
        "mean_us": round(sum(us) / len(us), 3) if us else 0.0,
    }


class LatencyRecorder:
    def __init__(self, maxlen: int = 200_000) -> None:
        self._samples: deque[int] = deque(maxlen=maxlen)
        self._lock = threading.Lock()

    def record(self, ns: int) -> None:
        with self._lock:
            self._samples.append(ns)

    def reset(self) -> None:
        with self._lock:
            self._samples.clear()

    def summary(self) -> dict[str, float | int]:
        with self._lock:
            samples = list(self._samples)
        return summarize_ns(samples)
