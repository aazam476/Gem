# Decision Log

Choices made without asking, and why. Newest last.

| # | Decision | Why |
|---|----------|-----|
| 1 | **One FastAPI service** hosts the AI proxy and the gateway; the gateway is still a separate module (`gateway.py` pure, `ingest.py` sole writer) with its own endpoint and metrics. | Fewer moving parts for a hackathon; the trust boundary is the code path, not the process. Splitting into two services later is mechanical. |
| 2 | **SQLite (WAL)** as the only datastore; no Firebase/Supabase. | With a backend already in the loop, a cloud DB adds keys, latency and setup without adding a feature. UNIQUE constraints give exactly-once for free. |
| 3 | **Backend feeds Gemini output straight into validation**; the phone confirms a server-held `capture_id` and never sends numbers. | Otherwise "zero-trust frontend" is false: a client could submit any vitals. |
| 4 | **Idempotency key = client UUID per capture** (+ UNIQUE `capture_id`), not timestamps. | Timestamps collide and can't tell a retry from a new reading. Reusing the key across retries makes lost responses safe. |
| 5 | **HTTP 422 for out-of-range, 409 for duplicates** (with the original event in the body); not 406. | 406 is for content negotiation. 409+event lets clients treat a retry as success. |
| 6 | **Two-tier limits**: `hard_min/hard_max` reject (AI misread), `min/max` flag but store. | A genuine 210 mmHg is clinically important and must not be thrown away as a "retake". |
| 7 | **Cross-field rule** (systolic > diastolic) and **read-back confirmation** with deterministic wording. | Range checks can't catch 142-vs-148; the patient can. Read-back text is built from parsed numbers so what's heard is what's stored. |
| 8 | **Gateway dry run at capture time** in addition to the binding run at confirm. | The patient shouldn't be asked "is 900 right?". Both runs are timed and rejections audited. |
| 9 | **`readings` untyped at the HTTP layer** of `/ingest_vitals`. | Lets the gateway reject *and audit* hallucinated strings/booleans instead of a generic schema 422. |
| 10 | **Gemini default `gemini-3.6-flash`**, configurable; `thinking_level=low`, `temperature=0`, JSON schema output. | 1.5 Flash is retired. 3.6 Flash is the GA Flash ID listed by Google's docs at build time (a 3.7 ID appeared on a Cloud page but couldn't be verified). Low thinking keeps latency down. |
| 11 | **Images resized by the long edge** (768 px on device, ≤1024 px server guard), never forced square. | Square resizing distorts seven-segment digits. Normalized box coords stay valid. |
| 12 | **AI budget 8 s server-side, 15 s client-side**; overlay shown immediately, "still working" after 5 s. | Gemini + upload often exceeds 5 s; blocking immediately (not after 5 s) is what prevents double submits. |
| 13 | **Voice is streamed separately** (`GET /captures/{id}/speech`) instead of inlined in the capture response. | The JSON (box + text) returns as soon as Gemini finishes; audio streams in parallel; failure falls back to on-device TTS after 3 s. |
| 14 | **Offline voice = `expo-speech`** (on-device TTS), optionally replaced by pre-generated ElevenLabs clips via `scripts/generate_fallback_audio.py`. | If the network is the problem we can't call ElevenLabs. Bundling clips requires a key at build time, so the generated module ships empty. |
| 15 | **Mock vision when no `GEMINI_API_KEY`** (reported in `/health` and the portal header), `GEM_MOCK_AI=1` to force it. | Tests and the offline demo need deterministic AI. A dark frame returns "not found" so failure paths are demoable. |
| 16 | **One active protocol, single step**; activating one deactivates the rest. | Sane MVP; the patient app doesn't need a picker. |
| 17 | **Hard-coded patient `patient-demo-001`, session = UUID per app launch, no auth.** | Non-goal for the MVP (see SPEC §2). |
| 18 | **Expo SDK 57** (latest stable on npm at build time; 58 is still `next`). | Expo Go store builds trail new SDKs; the newest *stable* is the safest match. |
| 19 | **No Expo Router**, single `App.tsx` switch on `Platform.OS` (`?patient` on web previews the patient app). | Two screens don't need a router; the spec asks for conditional rendering. |
| 20 | **Camera passed via a callback ref** (`attachCamera`) instead of a RefObject in the hook result. | React Compiler lint (`react-hooks/refs`) flags RefObjects passed through props/objects during render. |
| 21 | **Contract tests mock the hooks** and render each screen per state. | Lets a restyle be verified mechanically without a device. |
| 22 | **`load_test.py` starts its own server** (temp DB, mock AI) unless `--url` is given; reports server-side validation time, an in-process micro-benchmark, and end-to-end latency. | Reproducible on any laptop; "microseconds" is only true for the pure function, so all three numbers are shown. |
| 23 | **No Stop hook** wired in `.claude/settings.json`; `scripts/check.sh` is the single check command instead. | A blocking hook in a shared repo can trap unrelated sessions; the script gives the same signal on demand. |
| 24 | Pitch, demo script and Devpost notes kept in `docs/PITCH.md`, out of `CLAUDE.md`. | Agents start each session cold; keep their instructions focused. |
