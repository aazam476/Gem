# Build Plan

Each phase ends with a check that must be run and its output shown before the phase is
called done. `[x]` = done and verified in CI-like conditions (container); `[ ]` with 👤 =
needs a human (see HUMAN_TESTS.md).

## Phase 1 — Gateway (deterministic, no AI)
- [x] Rule schema with two-tier limits + cross-field rules (`app/rules.py`)
- [x] Pure `evaluate()` (`app/gateway.py`)
- [x] SQLite store, rule cache, UNIQUE idempotency key / capture id (`app/store.py`)
- [x] `ingest()` write path + `POST /ingest_vitals` + `/events`, `/rejections`, `/metrics/gateway`
- [x] Tests: valid, below/above range (flagged), implausible, missing, non-number, unknown metric, malformed, cross-field, duplicate, key conflict, 32 concurrent duplicates, inactive/unknown protocol, token, determinism
- **Check:** `cd backend && .venv/bin/pytest tests/test_gateway.py`

## Phase 2 — Gemini against the fixture
- [x] Dynamic system prompt + JSON schema from protocol metrics (`app/vision.py`)
- [x] Strict parser (grid, types, extra keys) + timeout/error mapping
- [x] Mock vision + synthetic BP-monitor fixture (`fixtures/`, `scripts/make_fixture.py`)
- [x] `POST /captures` with gateway dry run, read-back, `confirm`/`discard`, TTL
- [ ] 👤 Live read of the fixture: `GEM_LIVE_TESTS=1 pytest tests/test_live.py` (HUMAN_TESTS 1.1)
- **Check:** `cd backend && .venv/bin/pytest`

## Phase 3 — Voice
- [x] ElevenLabs Flash streaming proxy `GET /captures/{id}/speech`, 502 on failure
- [x] Fixed lines shared backend↔app (parity test), fallback-audio generator script
- [ ] 👤 Hear it on a phone (HUMAN_TESTS 2.4, 2.9, 3.2)
- **Check:** `cd backend && .venv/bin/pytest tests/test_captures.py -k speech`

## Phase 4 — Mobile patient app
- [x] Expo SDK 57 app, API client with timeouts, capture state machine
- [x] `useCapture`: in-flight lock, downscale by long edge, voice selection + 3 s fallback, idempotent confirm retries
- [x] Box mapping for cover-cropped view; frozen frame under the box
- [x] Barebones screens from primitives + theme; every element has a testID
- [x] Contract tests for every state; hook behavior tests
- [x] Web export + headless-Chromium run with a fake camera feeding the fixture (deploy → capture → box → confirm → saved)
- [ ] 👤 Real phone run (HUMAN_TESTS §2, §3)
- **Check:** `cd mobile && npm run typecheck && npm run lint && npm test`

## Phase 5 — Researcher portal
- [x] Protocol editor (BP template, metric rows, cross-field toggle, client-side validation), deploy/activate/deactivate
- [x] Live readings, blocked readings, gateway latency (polling)
- **Check:** contract tests above

## Phase 6 — Performance & docs
- [x] `load_test.py --workers 50 --events 1000` with invariant checks; report in PERFORMANCE.md
- [x] SPEC, API_CONTRACT, UI_CONTRACT, HUMAN_TESTS, DECISIONS, PITCH, README, CLAUDE.md
- [ ] 👤 Re-run the load test on the demo laptop and paste numbers into PERFORMANCE.md
- **Check:** `./scripts/check.sh`

## Phase 7 — Restyle handoff (next)
- [ ] Give the styling agent `docs/UI_CONTRACT.md` + `docs/screenshots/`
- [ ] After restyle: run `cd mobile && npm run typecheck && npm run lint && npm test`; reconnect anything the contract tests name
- [ ] 👤 HUMAN_TESTS §5

## Phase 8 — Gem assistant (camera + voice) ✅ built
- [x] Research Gemini context options (Live, Interactions, generateContent, image models) → ASSISTANT_SPEC §2
- [x] Backend session = context window (frames buffer, history, RAM answers), 10-min idle purge + sweeper, 410 tombstones
- [x] `POST /sessions/{id}/frames` (1 fps, change score), `POST …/turns` (WAV or text), `GET …/image`, `GET …/speech` (RAM cache)
- [x] Gem system prompt + JSON schema + strict parsing; boxes drawn server-side; mock brain
- [x] App: permission gate, full-screen camera, 1 fps frames, AudioStream + VAD, answer overlay, replay/dismiss, typed fallback, session recovery
- [x] Visual memory (5 min of changed frames, all sent per question, answer drawn on the chosen earlier frame)
- [x] Tests: backend 43 new; mobile VAD/WAV/state/audio-cache/hook/contract tests; web run with fake camera
- [ ] 👤 Phone run: HUMAN_TESTS §2–§4 (mic + VAD + ElevenLabs + real Gemini are untested by the agent)
- **Check:** `./scripts/check.sh`

## Phase 9 — Inactivity detection (next)
- [ ] `npx expo install expo-sensors`; `hooks/useMotion.ts` (DeviceMotion magnitude, 5 Hz)
- [ ] Pure `logic/activity.ts`: inactive when no speech, motion below threshold, and frame `change_score` below threshold for 60 s; unit tests with synthetic timelines
- [ ] Pause frames (`useFrameStreamer(enabled=false)`) after 1 min inactive; resume on motion/speech/scene change; UI "Paused — move or speak to wake Gem"
- [ ] Server purge already handles the 10-min context drop; add a client-side purge (DELETE) at 10 min for privacy
- [ ] HUMAN_TESTS for phone-on-table / phone-in-pocket / talking-while-still

## Phase 10 — Researcher context uploads (next)
- [ ] Data model: studies, documents (text, image, PDF), patient → study assignment
- [ ] Portal: upload/list/delete documents, write study notes
- [ ] Backend: Gemini Files API upload; explicit context cache per study (TTL refreshed while sessions are active); attach to turns; replace `study_context()` placeholder
- [ ] Prompt: cite which document an answer came from when relevant
- [ ] Tests with mocked Files/caches APIs; live test behind `GEM_LIVE_TESTS`

## Backlog (not started)
- Decide whether to delete the legacy capture/gateway endpoints or expose the gateway as a Gem tool
- Two-frame agreement before read-back (legacy flow)
- Multi-step protocols; per-patient enrollment and auth
- On-device detection for the AR box (MediaPipe) — see SPEC §9
- Offline capture queue on the phone
