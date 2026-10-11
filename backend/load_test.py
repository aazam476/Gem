"""Load test for the deterministic gateway (POST /ingest_vitals).

Usage:
    python load_test.py --workers 50 --events 1000
    python load_test.py --url http://192.168.1.20:8000 --workers 50 --events 1000

Without --url a private server is started (uvicorn, temp SQLite DB, mock AI) so the
numbers are reproducible on any laptop. Reports three latencies:
  1. validation-only: perf_counter_ns around the pure gateway function, as measured by
     the server for every request (GET /metrics/gateway);
  2. in-process micro-benchmark of the same function (no server, no I/O);
  3. end-to-end HTTP round trip seen by the client (validation + idempotency check +
     SQLite write + JSON + loopback network).
It also checks the correctness invariants under load: rejected payloads never stored,
duplicates counted once.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import random
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.gateway import compile_rules, evaluate  # noqa: E402
from app.metrics import percentile, summarize_ns  # noqa: E402
from app.rules import blood_pressure_preset  # noqa: E402


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_server(tmpdir: str) -> tuple[subprocess.Popen, str]:
    port = free_port()
    env = {
        **os.environ,
        "GEM_DATABASE_PATH": str(Path(tmpdir) / "load.db"),
        "GEM_MOCK_AI": "1",
        "GEM_GATEWAY_TOKEN": "",
    }
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:get_app", "--factory",
         "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning",
         "--no-access-log"],
        cwd=Path(__file__).resolve().parent, env=env,
    )
    url = f"http://127.0.0.1:{port}"
    deadline = time.time() + 20
    while time.time() < deadline:
        try:
            if httpx.get(f"{url}/health", timeout=1).status_code == 200:
                return proc, url
        except httpx.HTTPError:
            time.sleep(0.1)
    proc.kill()
    raise SystemExit("server did not start")


def build_workload(n: int, protocol_id: str, dup_rate: float, bad_rate: float, seed: int) -> list[dict]:
    rng = random.Random(seed)
    events: list[dict] = []
    for i in range(n):
        roll = rng.random()
        if events and roll < dup_rate:
            prev = rng.choice(events)
            events.append({**prev, "_kind": "duplicate" if prev["_kind"] != "invalid" else "invalid"})
            continue
        key = str(uuid.UUID(int=rng.getrandbits(128)))
        if roll < dup_rate + bad_rate:
            readings = {"systolic": 900, "diastolic": 82}  # hallucination
            kind = "invalid"
        else:
            sys_v = rng.randint(95, 175)
            readings = {"systolic": sys_v, "diastolic": rng.randint(55, min(105, sys_v - 10)),
                        "pulse": rng.randint(50, 110)}
            kind = "valid"
        events.append({
            "protocol_id": protocol_id, "patient_id": f"patient-{i % 25:03d}",
            "session_id": f"load-{seed}", "idempotency_key": key, "readings": readings, "_kind": kind,
        })
    return events


def microbench(iterations: int) -> dict:
    rules = compile_rules(blood_pressure_preset())
    payload = {"systolic": 128, "diastolic": 82, "pulse": 71}
    for _ in range(1000):  # warm-up
        evaluate(rules, payload)
    samples = []
    for _ in range(iterations):
        t = time.perf_counter_ns()
        evaluate(rules, payload)
        samples.append(time.perf_counter_ns() - t)
    return summarize_ns(samples)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--workers", type=int, default=50)
    ap.add_argument("--events", type=int, default=1000)
    ap.add_argument("--url", default=None, help="existing server; default starts a private one")
    ap.add_argument("--token", default="", help="X-Gateway-Token if the server requires it")
    ap.add_argument("--duplicate-rate", type=float, default=0.10)
    ap.add_argument("--invalid-rate", type=float, default=0.10)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--json", dest="json_out", default=None, help="write the report as JSON here")
    args = ap.parse_args()

    tmp = tempfile.TemporaryDirectory()
    proc = None
    url = args.url
    if url is None:
        proc, url = start_server(tmp.name)
    try:
        headers = {"X-Gateway-Token": args.token} if args.token else {}
        with httpx.Client(base_url=url, headers=headers, timeout=10) as c:
            protocol = c.post("/protocols", json={
                "title": "Load test BP", "prompt_text": "Read the blood pressure monitor.",
                "validation_rules": blood_pressure_preset().model_dump(), "activate": True,
            }).json()
            c.post("/metrics/gateway/reset")
            stored_before = c.get("/metrics/gateway").json()["events_stored"]

        workload = build_workload(args.events, protocol["protocol_id"], args.duplicate_rate,
                                  args.invalid_rate, args.seed)
        local = threading.local()
        latencies_ms: list[float] = []
        statuses: dict[str, dict[int, int]] = {}
        lock = threading.Lock()

        def send(item: dict) -> None:
            client = getattr(local, "client", None)
            if client is None:
                client = local.client = httpx.Client(base_url=url, headers=headers, timeout=10)
            body = {k: v for k, v in item.items() if not k.startswith("_")}
            t = time.perf_counter()
            r = client.post("/ingest_vitals", json=body)
            elapsed = (time.perf_counter() - t) * 1000
            with lock:
                latencies_ms.append(elapsed)
                statuses.setdefault(item["_kind"], {}).setdefault(r.status_code, 0)
                statuses[item["_kind"]][r.status_code] += 1

        wall = time.perf_counter()
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            list(pool.map(send, workload))
        wall = time.perf_counter() - wall

        with httpx.Client(base_url=url, timeout=10) as c:
            server = c.get("/metrics/gateway").json()

        unique_valid = len({e["idempotency_key"] for e in workload if e["_kind"] != "invalid"})
        stored = server["events_stored"] - stored_before
        lat = sorted(latencies_ms)
        report = {
            "environment": {
                "machine": platform.machine(), "platform": platform.platform(),
                "cpu_count": os.cpu_count(), "python": platform.python_version(),
                "server": "private uvicorn (1 worker) + SQLite WAL, loopback" if proc else url,
            },
            "workload": {
                "events": args.events, "workers": args.workers,
                "duplicate_rate": args.duplicate_rate, "invalid_rate": args.invalid_rate,
                "seed": args.seed,
            },
            "validation_only_server": server["validation"],
            "validation_only_microbench": microbench(100_000),
            "end_to_end_ms": {
                "p50": round(percentile(lat, 50), 3), "p95": round(percentile(lat, 95), 3),
                "p99": round(percentile(lat, 99), 3), "max": round(lat[-1], 3),
            },
            "throughput_rps": round(args.events / wall, 1),
            "status_codes": statuses,
            "invariants": {
                "unique_valid_keys": unique_valid,
                "events_stored": stored,
                "exactly_once": stored == unique_valid,
                "no_invalid_stored": all(code == 422 for code in statuses.get("invalid", {})),
            },
        }
    finally:
        if proc is not None:
            proc.terminate()
            proc.wait(timeout=10)
        tmp.cleanup()

    v, m, e = report["validation_only_server"], report["validation_only_microbench"], report["end_to_end_ms"]
    print(f"\nGem gateway load test — {args.events} events, {args.workers} workers")
    print(f"  environment : {report['environment']['platform']}, {report['environment']['cpu_count']} CPUs, "
          f"Python {report['environment']['python']}")
    print(f"  validation  : p50 {v['p50_us']} µs | p95 {v['p95_us']} µs | p99 {v['p99_us']} µs  (server, n={v['count']})")
    print(f"  microbench  : p50 {m['p50_us']} µs | p95 {m['p95_us']} µs | p99 {m['p99_us']} µs  (in-process, n={m['count']})")
    print(f"  end-to-end  : p50 {e['p50']} ms | p95 {e['p95']} ms | p99 {e['p99']} ms  (HTTP + SQLite)")
    print(f"  throughput  : {report['throughput_rps']} req/s")
    print(f"  status codes: {json.dumps(report['status_codes'])}")
    inv = report["invariants"]
    print(f"  invariants  : exactly_once={inv['exactly_once']} ({inv['events_stored']} stored / "
          f"{inv['unique_valid_keys']} unique valid keys), no_invalid_stored={inv['no_invalid_stored']}")
    if args.json_out:
        Path(args.json_out).write_text(json.dumps(report, indent=2))
    if not (inv["exactly_once"] and inv["no_invalid_stored"]):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
