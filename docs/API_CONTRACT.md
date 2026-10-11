# Gem API Contract

Base URL: `http://<backend-host>:8000`. JSON in, JSON out (except `/speech`, which
returns `audio/mpeg`). Machine-readable: [`openapi.json`](openapi.json) (regenerate:
`cd backend && .venv/bin/python -c "import json;from app.main import create_app;from app.config import load_settings;print(json.dumps(create_app(load_settings(database_path=':memory:',mock_ai=True)).openapi(),indent=2))" > ../docs/openapi.json`).
TypeScript mirror: `mobile/src/api/types.ts`. Pydantic source: `backend/app/schemas.py`, `backend/app/rules.py`.

IDs (`protocol_id`, `patient_id`, `session_id`, `idempotency_key`) match `^[A-Za-z0-9_.:-]{1,128}$`.

## Errors

Every non-2xx body is an `ErrorBody`:
```json
{"error": "rejected", "message": "Readings failed deterministic validation.",
 "errors": [{"code": "implausible", "metric": "systolic", "message": "systolic=900 is outside plausible limits [50, 260]"}],
 "event": null, "voice_line_id": "retake_unusual", "voice_script": "That reading looks unusual. Let's take it one more time to be safe."}
```
Clients branch on `error` (stable code), never on `message`.

| `error` | HTTP | Meaning |
|---------|------|---------|
| `malformed` | 422 | Body failed schema validation (`errors[].metric` = JSON path) |
| `rejected` | 422 | Gateway rejected the readings (`errors[]` lists why) |
| `bad_image` | 422 | Upload not decodable / empty / too large |
| `duplicate` | 409 | Already recorded; `event` is the original record |
| `idempotency_conflict` | 409 | Key reused with a different payload |
| `protocol_inactive` | 409 | Protocol exists but is not active |
| `capture_not_confirmable` | 409 | Capture is unreadable/rejected/discarded (or already confirmed, for discard) |
| `capture_expired` | 410 | Capture older than `GEM_CAPTURE_TTL_S` (default 600 s) |
| `protocol_not_found`, `no_active_protocol`, `capture_not_found`, `voice_disabled` | 404 | |
| `unauthorized` | 401 | `GEM_GATEWAY_TOKEN` set and `X-Gateway-Token` missing/wrong |
| `voice_unavailable` | 502 | ElevenLabs failed before streaming started |

## Meta

### `GET /health` → 200
`{"status": "ok", "ai_mode": "gemini"|"mock", "voice_enabled": bool, "gemini_model": str, "active_protocol_id": str|null}`

### `GET /presets/blood_pressure` → 200 `ValidationRules`

## Protocols (portal)

`ValidationRules`:
```json
{"metrics": [{"name": "systolic", "label": "systolic", "unit": "mmHg",
              "min": 90, "max": 180, "hard_min": 50, "hard_max": 260, "required": true}],
 "cross_field": [{"type": "greater_than", "left": "systolic", "right": "diastolic"}]}
```
`name` matches `^[a-z][a-z0-9_]{0,31}$`; 1–12 metrics; `hard_min <= min <= max <= hard_max`.

`Protocol`: `{protocol_id, title, prompt_text, validation_rules, is_active, created_at}`

| Method & path | Body | Success | Notes |
|---------------|------|---------|-------|
| `POST /protocols` | `{title, prompt_text, validation_rules, activate=true}` | 201 `Protocol` | `activate` deactivates all others (one active at a time) |
| `GET /protocols` | — | 200 `Protocol[]` newest first | |
| `GET /protocols/active` | — | 200 `Protocol` | 404 `no_active_protocol` |
| `GET /protocols/{id}` | — | 200 `Protocol` | 404 |
| `POST /protocols/{id}/activate` | — | 200 `Protocol` | |
| `POST /protocols/{id}/deactivate` | — | 200 `Protocol` | |

## Capture pipeline (patient app)

### `POST /captures`
Request: `{protocol_id, patient_id, session_id, image_base64}` (JPEG/PNG, optional `data:` prefix, ≤ 6 MB decoded).

Response 200 `CaptureOut` — the analysis outcome is in `status`, not the HTTP code:
```json
{"capture_id": "uuid",
 "status": "needs_confirmation" | "unreadable" | "rejected",
 "reason": null | "no_display" | "invalid_output" | "ai_timeout" | "ai_error" | "gateway_rejected",
 "bounding_box": [ymin, xmin, ymax, xmax] | null,   // 0-1000, relative to the uploaded image
 "image_width": 768, "image_height": 1024,          // after EXIF rotation, before server resize
 "readings": {"systolic": 142, "diastolic": 90} | null,
 "flags":  [Issue],        // plausible but outside expected range
 "errors": [Issue],        // why the gateway dry run rejected
 "voice_line_id": null | "retake_unclear" | "retake_unusual" | "network_error",
 "voice_script": "I read 142 over 90. Is that right?",
 "audio_url": "/captures/{id}/speech" | null,       // null when ElevenLabs is not configured
 "ai_latency_ms": 1234.5,
 "validation_ns": 2100 | null}
```
Errors: 404/409 protocol, 422 `bad_image`, 422 `malformed`.

### `POST /captures/{capture_id}/confirm`
Request: `{idempotency_key}` — generate once per capture, reuse on retries.
Responses: same as `/ingest_vitals` below, plus 404 `capture_not_found`,
409 `capture_not_confirmable`, 410 `capture_expired`. Confirming an already-confirmed
capture with any key returns 409 `duplicate` with the original event.

### `POST /captures/{capture_id}/discard` → 200
`{"capture_id", "status": "discarded", "voice_line_id": "retake_requested", "voice_script"}`

### `GET /captures/{capture_id}/speech` → 200 `audio/mpeg` (chunked stream)
ElevenLabs `eleven_flash_v2_5`, `mp3_44100_64`, of that capture's `voice_script`.
404 `voice_disabled` when no key / mock mode; 502 `voice_unavailable` on upstream failure.
Client falls back to on-device TTS in both cases (and if playback hasn't started in 3 s).

## Deterministic gateway

### `POST /ingest_vitals`
Header (only if `GEM_GATEWAY_TOKEN` is set): `X-Gateway-Token`.
Request:
```json
{"protocol_id": "…", "patient_id": "patient-demo-001", "session_id": "…",
 "idempotency_key": "uuid", "readings": {"systolic": 128, "diastolic": 82}}
```
`readings` is intentionally an untyped object: the gateway (not the HTTP layer) judges it,
so hallucinated strings/booleans are rejected *and audited*.

| Result | HTTP | Body |
|--------|------|------|
| accepted / flagged | 201 | `IngestResponse` `{result, event: ClinicalEvent, validation_ns, voice_line_id: "saved"\|"saved_flagged", voice_script}` |
| duplicate | 409 | `ErrorBody` `error=duplicate`, `event`, `voice_line_id=already_saved` |
| key reused, different payload | 409 | `error=idempotency_conflict`, `event` |
| rejected | 422 | `error=rejected`, `errors[]`, `validation_ns`, `voice_line_id=retake_unusual` |
| inactive / unknown protocol | 409 / 404 | |

`ClinicalEvent`: `{event_id, protocol_id, patient_id, session_id, capture_id, idempotency_key, status: "accepted"|"flagged", extracted_data: {metric: number}, flags: [Issue], validation_ns, timestamp}`

`Issue`: `{code, metric, message}`. Codes: `implausible`, `missing_metric`, `not_a_number`,
`unexpected_metric`, `malformed`, `cross_field`, `below_range`, `above_range`.

### Read endpoints
| Method & path | Success |
|---------------|---------|
| `GET /events?protocol_id=&limit=50` | 200 `ClinicalEvent[]` newest first (limit 1–500) |
| `GET /rejections?protocol_id=&limit=50` | 200 `Rejection[]` `{rejection_id, protocol_id, patient_id, session_id, capture_id, idempotency_key, readings, errors, validation_ns, timestamp}` |
| `GET /metrics/gateway` | 200 `{"validation": {count, p50_us, p95_us, p99_us, max_us, mean_us}, "events_stored": int}` |
| `POST /metrics/gateway/reset` | 200 (load test only) |

## Gem assistant

The phone app's API. A **session** is Gem's context window: recent frames + conversation
history + recent answers, in RAM, purged after `idle_timeout_s` (600) without a frame or
a prompt. Spec: [ASSISTANT_SPEC.md](ASSISTANT_SPEC.md).

| `error` | HTTP | Meaning |
|---------|------|---------|
| `session_expired` | 410 | Purged after 10 idle minutes (or ended). Open a new session. |
| `session_not_found` | 404 | Unknown id (e.g. server restarted). Open a new session. |
| `turn_in_progress` | 409 | A question is already being answered in this session |
| `bad_audio` | 422 | `audio_base64` not base64, empty, or > 4 MB |
| `ai_timeout` | 504 | Gemini didn't answer within `GEM_ASSISTANT_TIMEOUT_S` (`voice_line_id=network_error`) |
| `ai_error`, `invalid_output` | 502 | Gemini failed or returned unusable JSON (`voice_line_id=network_error`) |
| `turn_not_found`, `no_image`, `voice_disabled` | 404 | |
| `voice_unavailable` | 502 | ElevenLabs failed; speak the answer on-device |

### `POST /sessions` → 201 `Session`
Body optional: `{"patient_id": "patient-demo-001"}`.
```json
{"session_id": "uuid", "idle_timeout_s": 600, "expires_in_s": 600, "frame_interval_ms": 1000,
 "frames_buffered": 0, "frames_received": 0, "turns": 0, "study_context": true}
```
`study_context` is true when a protocol was active at creation (its text is given to Gemini).

### `GET /sessions/{id}` → 200 `Session` · `DELETE /sessions/{id}` → 204
Reading does not extend the idle timeout.

### `POST /sessions/{id}/frames` → 200
Request `{"image_base64": "<jpeg>"}` (≤ 3 MB decoded; downscaled to 768 px long edge). Counts as activity.
```json
{"frames_buffered": 10, "frames_received": 57, "change_score": 0.08, "expires_in_s": 600}
```
`change_score`: mean absolute difference vs. the previous frame on 32×32 grayscale, 0–1;
`null` for the first frame. (Input for the planned inactivity detector.)

### `POST /sessions/{id}/turns` → 200 `Turn`
Exactly one of:
- `{"audio_base64": "<wav>", "audio_mime": "audio/wav"}` — the user's utterance (16 kHz mono PCM WAV from the app; `audio/mp3|mpeg|aac|ogg|flac|mp4` also accepted)
- `{"text": "Where is the start button?"}` — typed question

Counts as activity. The newest `GEM_FRAMES_PER_TURN` (3) frames, the history and the input go to Gemini.
```json
{"turn_id": "uuid",
 "status": "answered" | "ignored",          // ignored = no speech / not addressed to Gem
 "transcript": "where is the start button",
 "answer": "It's the round blue button below the screen. I've marked it.",
 "annotations": [{"label": "start button", "box_2d": [785, 470, 865, 530]}],  // [ymin,xmin,ymax,xmax] 0-1000 on the newest frame
 "image_url": "/sessions/{id}/turns/{turn_id}/image" | null,                     // null when no frames / ignored
 "image_width": 768, "image_height": 576,
 "audio_url": "/sessions/{id}/turns/{turn_id}/speech" | null,                    // null without ElevenLabs
 "frames_used": 3, "latency_ms": 1840.2}
```

### `GET /sessions/{id}/turns/{turn_id}/image` → 200 `image/jpeg`
The newest frame at question time with the annotations drawn (yellow boxes, black labels;
tiny boxes drawn as rings). Kept in RAM for the last 10 answers.

### `GET /sessions/{id}/turns/{turn_id}/speech` → 200 `audio/mpeg`
ElevenLabs `eleven_flash_v2_5` of `answer`. First request streams it while caching it
(`X-Gem-Audio-Cache: miss`); later requests return the cached bytes (`hit`) — ElevenLabs is
billed once per answer. Concurrent first requests wait for the same synthesis.
