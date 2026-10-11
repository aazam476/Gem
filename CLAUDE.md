# Gem — agent instructions

**Gem** is a camera + voice assistant for decentralized clinical trials. The phone app is a
full-screen camera that sends one frame per second to a backend session (Gem's context
window), listens continuously, and when the user stops talking sends the utterance to
Gemini with the latest frames; Gem answers with a photo of the scene with markings and a
short answer read aloud by ElevenLabs. Researchers use the web portal (protocols today,
study documents next). A deterministic validation gateway (legacy capture flow) also lives
in the backend.

Read `docs/ASSISTANT_SPEC.md` (the app), `docs/SPEC.md` (portal/gateway) and
`docs/API_CONTRACT.md` (HTTP) before changing either side.

## Stack (pinned)
- Backend: Python 3.12+ (tested on 3.13), FastAPI 0.143, Pydantic 2, SQLite (WAL), `google-genai` 2.29, httpx. `backend/requirements.txt`.
- Mobile + portal: one Expo **SDK 57** app (React Native 0.86, React 19.2, TypeScript 6). Web build = researcher portal, native = Gem assistant app.
  Audio is `expo-audio` (expo-av no longer exists). Add native deps only with `npx expo install` and only Expo Go-compatible modules.
- Models: assistant `GEMINI_ASSISTANT_MODEL` (default `gemini-3.8-flash`), legacy reader `GEMINI_MODEL` (`gemini-3.6-flash`), ElevenLabs `eleven_flash_v2_5`. All configurable in `backend/.env`.
- Mic: `expo-audio` `useAudioStream` (PCM, native only — null on web) + `src/logic/vad.ts`. Camera frames: `expo-camera` `takePictureAsync` every second.

## Commands
```bash
# backend (from backend/)
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/pytest                                  # all backend tests, no network
.venv/bin/pytest tests/test_gateway.py            # gateway invariants only
.venv/bin/python load_test.py --workers 50 --events 1000
.venv/bin/uvicorn app.main:get_app --factory --host 0.0.0.0 --port 8000

# mobile (from mobile/)
npm install
npm run typecheck && npm run lint && npm test
npx expo start            # press w for portal, scan QR in Expo Go for the Gem app

# everything
./scripts/check.sh
```

## Hard rules
- **No secrets in `mobile/`.** Anything `EXPO_PUBLIC_*` ships to phones. Keys live only in `backend/.env` (gitignored).
- **No live API calls in tests.** Backend tests block outbound sockets; use `ScriptedVision`/`httpx.MockTransport`. Live checks go in `tests/test_live.py` behind `GEM_LIVE_TESTS=1`.
- **Gem's context is RAM-only.** Frames, transcripts, drawn images and audio live in `SessionStore` and are purged after 10 idle minutes (the app also ends the session after 10 min of inactivity, `useActivity`). Don't persist them without an explicit decision. Researcher study documents (`assistant/documents.py`, `backend/uploads/`) are the exception: they're research material and are persisted.
- **Prompt order is documents → frames → history → question** (stable prefix for Gemini's implicit caching). Keep new context in that order.
- **No interrupting Gem.** The mic is ignored while Gem thinks, while it speaks and while the user has muted it (`isMicMuted`), plus 300 ms after (speaker tail). Muting mid-sentence drops the sentence; only speech that ends unmuted is sent. Mute by ignoring buffers; the stream itself is only stopped on iOS while Gem's voice plays (AudioStream's record-only session must give way to playback) — by the player, *before* audio starts (`standBy`), never mid-playback — and is restarted the moment Gem finishes — always `stop()` before `start()`, with the stall watchdog as backup. Keep the server echo check (`assistant/echo.py`).
- **Frames are ~1080p stills** (`pictureSize` from `logic/camera.ts`), never the default full-resolution "Photo" preset, which stalls the preview every second.
- **No frames while the answer screen is up** (`shouldStreamFrames`); they resume on Dismiss.
- **Gemini never draws pixels.** It returns boxes; `app/assistant/render.py` draws them. Parse its JSON strictly (`brain.parse_reply`).
- **Only `app/ingest.py::ingest` writes `clinical_events`** (legacy gateway path).
- **`app/gateway.py` stays pure**: no I/O, no AI, no clock. Anything it decides must be unit-tested in `tests/test_gateway.py`.
- **Screens contain no logic.** Behavior goes in `src/hooks`, `src/services`, `src/logic`. Every required element has the `testID` listed in `docs/UI_CONTRACT.md`; keep the contract tests passing.
- Keep `backend/app/voice_lines.py` and `mobile/src/services/voiceLines.json` identical (a test enforces it).
- Commits: conventional prefixes (`feat`, `fix`, `chore`, `refactor`, `docs`, `style`, `test`).

## Autonomy
- If a reasonable choice exists, make it, log it in `docs/DECISIONS.md` (choice + why), and keep going.
- Stop and ask only if: (1) you need a secret, account, or install only the human can provide; (2) two spec requirements conflict in a way that changes the API contract; (3) the same check has failed three times with different fixes.
- Checks needing a physical phone, camera, or audio: don't stop. Add exact steps and the expected result to `docs/HUMAN_TESTS.md`, finish everything else that's unblocked, and ask once at the end of the phase.
- Never call a phase done without running its check (`./scripts/check.sh` or the phase's command in `docs/TASKS.md`) and showing the output.

## After a UI restyle by another agent
Run `cd mobile && npm run typecheck && npm run lint && npm test`. Failing contract tests name the testID/handler/state that was dropped; reconnect it to the hook without changing the hook's API. See `docs/UI_CONTRACT.md`.

## Map
- `backend/app/assistant/` — `sessions.py` (context window + idle purge), `brain.py` (Gem prompt, schema, Gemini/mock), `render.py` (draw boxes), `routes.py` (`/sessions/...`), `documents.py` (study documents + Gemini Files), `echo.py`
- `backend/app/` — `main.py` (app + portal/gateway routes), `gateway.py` (pure validation), `ingest.py`, `store.py` (SQLite + rule cache), `vision.py` (legacy reader), `voice.py` (ElevenLabs), `imaging.py`, `rules.py`, `voice_lines.py`
- `mobile/src/` — `hooks/useAssistant.ts` (orchestration), `useSpeechCapture.ts`, `useFrameStreamer.ts`, `useActivity.ts`, `usePermissions.ts`, `usePortal.ts`; `logic/` (`vad`, `pcm`, `wav`, `camera`, `activity`, `assistantState`, `rulesForm`); `services/` (`answerAudio`, `audioMode`, `image`, `lines`, `pickFile`); `screens/assistant/`, `screens/portal/`; `ui/`; `__tests__/`
- `docs/` — ASSISTANT_SPEC, SPEC, API_CONTRACT, UI_CONTRACT, TASKS, DECISIONS, HUMAN_TESTS, PERFORMANCE, PITCH (pitch only)
