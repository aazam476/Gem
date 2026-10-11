# Performance Report — Deterministic Gateway

> Paste Lucera's official performance-report template here verbatim if it differs from
> the five headings below (taken from our design doc); then map these sections onto it.

## Environment limits

| | |
|---|---|
| Machine | Cloud dev container, Intel Xeon @ 2.10 GHz, **4 vCPUs**, 15 GB RAM, Linux 6.18 x86_64 |
| Runtime | Python 3.13.16, FastAPI 0.143, uvicorn 0.54 (**1 worker process**), SQLite WAL (`synchronous=NORMAL`) |
| Network | Loopback only; load generator and server share the same 4 vCPUs |
| AI | Not involved: the gateway never calls Gemini/ElevenLabs (mock vision configured, unused by `/ingest_vitals`) |
| Limits | Single writer lock on SQLite; Python GIL; client and server compete for CPU, so end-to-end numbers are pessimistic |

## Workload

`python load_test.py --workers 50 --events 1000` (seed 7):
- 1000 `POST /ingest_vitals` requests from 50 concurrent client threads (keep-alive).
- Mix: ~80% valid blood-pressure readings (randomized, 25 synthetic patients), ~10%
  hallucinations (`systolic: 900`), ~10% replays of an earlier idempotency key.
- Rules: blood-pressure preset (3 metrics, two-tier limits, systolic > diastolic), compiled
  and cached in memory.

## Metric

1. **Gateway validation latency** (the Lucera metric): `time.perf_counter_ns()` immediately
   around the pure `gateway.evaluate(rules, readings)` call, inside the server, for every
   request that reaches validation. Excludes network, JSON parsing, the idempotency lookup,
   the database write and any AI time. Exposed at `GET /metrics/gateway`.
2. **Micro-benchmark**: the same function called 100 000× in a warm loop, no server.
3. **End-to-end**: client-observed HTTP round trip (validation + idempotency check + SQLite
   insert + JSON + loopback), p50/p95/p99.
Plus **correctness under load**: rows stored == unique valid keys; no rejected payload stored.

## Procedure

```bash
cd backend
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python load_test.py --workers 50 --events 1000 --json report.json
.venv/bin/python load_test.py --workers 1  --events 1000      # uncontended baseline
```
The script starts a private uvicorn server on a free port with a temp database, creates the
protocol, resets the metrics, fires the workload, reads `/metrics/gateway`, runs the
micro-benchmark, prints the report, and exits non-zero if an invariant fails. Add
`--url http://host:8000` to target a running server instead.

## Results (2026-10-11, environment above)

| Measurement | p50 | p95 | p99 | n |
|---|---|---|---|---|
| Gateway validation, in server (50 workers) | **18.5 µs** | **33.8 µs** | **52.0 µs** | 921 |
| Gateway validation, in server (1 worker) | 15.9 µs | 26.9 µs | 42.1 µs | 918 |
| Gateway validation, micro-benchmark | 1.9 µs | 2.4 µs | 4.2 µs | 100 000 |
| End-to-end HTTP, 50 workers | 84.0 ms | 117.5 ms | 136.1 ms | 1000 |
| End-to-end HTTP, 1 worker | 2.2 ms | 3.0 ms | 5.4 ms | 1000 |

Throughput: 207 req/s at 50 workers, 418 req/s at 1 worker (single uvicorn process).

Status codes (50 workers): valid → 797×201 + 3×409; hallucinations → 118×422; replays →
79×409 + 3×201. The 3+3 swaps are races where a replay arrived before its original; each
key was still stored exactly once.

Invariants: **800 events stored for 800 unique valid keys (exactly-once ✔); 0 of 118
hallucinated payloads stored ✔.**

## Interpretation

- The deterministic check itself is a few microseconds (≈2 µs warm, ≈16–19 µs p50 inside a
  busy server, where caches are cold between requests and the GIL is shared with HTTP
  handling). Either way it is 4–5 orders of magnitude below the AI step (≈1–3 s per
  capture), so **validation adds no perceptible latency** to the patient flow.
- "Microsecond latency" is true only for the pure function with rules cached in memory.
  Once the request includes the idempotency lookup and a durable insert, the honest number is
  **milliseconds** (2.2 ms p50 uncontended).
- At 50 concurrent clients the end-to-end tail is dominated by queueing: one Python process,
  a serialized SQLite writer, and a load generator competing for the same 4 vCPUs.
  Throughput *drops* with more concurrency, which points at contention rather than the
  gateway. Next levers: multiple uvicorn workers + a server DB (Postgres) with the same
  UNIQUE constraints, or batching inserts; and running the load generator on another host.
- Correctness held under contention: duplicate and concurrent submissions were counted once,
  and every out-of-bounds payload was rejected and audited, not stored.
