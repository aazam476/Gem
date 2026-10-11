# Human Tests

Things an agent cannot verify in a container: a real phone, camera, speaker, live API keys,
and Gemini's accuracy on a physical device. Run these once per phase; record results in the
table at the bottom.

## 0. One-time setup (only you can do this)

1. **Keys.** `cp backend/.env.example backend/.env`, fill `GEMINI_API_KEY` and
   `ELEVENLABS_API_KEY`. Confirm the current Flash model ID at
   https://ai.google.dev/gemini-api/docs/models and set `GEMINI_MODEL` if it differs from
   `gemini-3.6-flash`.
2. **Phone.** Install Expo Go. In Expo Go → Settings, confirm it supports **SDK 57**. If the
   store build only supports an older SDK, tell the agent; don't upgrade/downgrade by hand.
3. **Network.** Phone and laptop on the same Wi-Fi (venue Wi-Fi often isolates clients; a
   phone hotspot works). Find the laptop LAN IP (`ipconfig getifaddr en0` on macOS,
   `hostname -I` on Linux). Then `echo "EXPO_PUBLIC_API_URL=http://<LAN-IP>:8000" > mobile/.env`.
   If LAN is blocked: run a tunnel for port 8000 (e.g. `cloudflared tunnel --url http://localhost:8000`)
   and use that https URL, and start Expo with `npx expo start --tunnel`.
4. **Fixtures.** A real upper-arm BP monitor (or a clear photo of one on another screen).

Start everything:
```bash
cd backend && .venv/bin/uvicorn app.main:get_app --factory --host 0.0.0.0 --port 8000
cd mobile && npx expo start          # w = portal in browser; scan QR in Expo Go = patient app
```

## 1. Live API checks (laptop only)

| # | Steps | Expected |
|---|-------|----------|
| 1.1 | `cd backend && GEM_LIVE_TESTS=1 .venv/bin/pytest tests/test_live.py -s` | 2 passed. Gemini reads the synthetic fixture as systolic 128, diastolic 82. If it fails with "model not found", fix `GEMINI_MODEL`. |
| 1.2 | `curl localhost:8000/health` | `"ai_mode":"gemini"`, `"voice_enabled":true` |

## 2. Patient app on a phone (Expo Go)

| # | Steps | Expected |
|---|-------|----------|
| 2.1 | In the portal click "Use blood pressure template" → "Deploy to patients". Open Expo Go, scan the QR. | Instructions from the portal appear at the top; camera permission prompt appears. |
| 2.2 | Allow camera. | Live camera preview; "Read my device" becomes enabled within ~2 s. |
| 2.3 | Point at the BP monitor showing a reading, tap "Read my device" **three times quickly**. | Blocking overlay appears immediately; only **one** capture appears in backend logs. |
| 2.4 | Wait for the result. | Frozen photo; **green box sits on the monitor's display** (check alignment, portrait); large numbers match the monitor; you **hear** an ElevenLabs voice say "I read X over Y…". Note total time from tap to voice. |
| 2.5 | Tap "Yes, that's right". | "Saved" + voice says "Thank you. Your reading has been saved." Reading appears in the portal within ~4 s. |
| 2.6 | Repeat 2.4 but tap "No, try again". | Voice: "No problem. Let's take it again." Back to camera. Nothing new in the portal. |
| 2.7 | Cover the lens with a finger, tap "Read my device". | Unclear state; voice asks you to retake (Gemini guidance or "I couldn't quite see that clearly…"). |
| 2.8 | Point at a screen with random text / no device. | Unclear state, no numbers stored. |
| 2.9 | Ringer/silent switch ON (iPhone), repeat 2.4. | Voice still audible (`playsInSilentMode`). |
| 2.10 | "Say that again" in any result state. | The same line plays again. |

## 3. Failure behavior on a phone

| # | Steps | Expected |
|---|-------|----------|
| 3.1 | Stop the backend, tap "Read my device". | Within ~15 s: "I'm having trouble connecting…" spoken **by the phone** (on-device voice), Try again button. |
| 3.2 | Restart backend with `ELEVENLABS_API_KEY=` (empty), capture. | Read-back spoken with on-device voice; no long silence (≤ 3 s). |
| 3.3 | Backend with `GEM_MOCK_AI=1 GEM_MOCK_READINGS='{"systolic": 900, "diastolic": 82}'`, capture anything. | "That reading looks unusual. Let's take it one more time to be safe." Portal "Blocked by the gateway" shows systolic=900. |
| 3.4 | `GEM_MOCK_READINGS='{"systolic": 210, "diastolic": 100}'`, capture, confirm. | Flag notice on the confirm card; after saving, voice says the study team will take a look; portal shows ⚑ Flagged. |
| 3.5 | Capture, then turn on airplane mode, tap "Yes". Turn airplane mode off, tap "Yes" again. | First tap: error on the confirm card + spoken network line. Second: Saved. Portal shows **one** reading. |
| 3.6 | Offline demo mode: `GEM_MOCK_AI=1`, no keys, full flow. | Works end to end with on-device voice (use if venue Wi-Fi fails). |

## 4. Accuracy sample (Gemini on real hardware)

Take 10 readings across lighting/angles. Record monitor value vs. read-back. Target: ≥ 9/10
exact before confirmation; every miss must be either "unclear" or caught by the patient at
read-back (never silently stored).

## 5. UI smoke (after the restyle)

Run sections 2.1–2.6 and 3.1 again, then `cd mobile && npm test`. Check text is ≥ 20 px,
buttons are large, and the box still aligns with the display.

## 6. Optional

- `cd backend && .venv/bin/python scripts/generate_fallback_audio.py`, reload the app, repeat
  3.1: the network-error line now uses the bundled ElevenLabs voice.
- Load test from your laptop for the README numbers:
  `cd backend && .venv/bin/python load_test.py --workers 50 --events 1000`.

## Results log

| Date | Tester | Section | Pass/Fail | Notes (device, OS, timings) |
|------|--------|---------|-----------|-----------------------------|
| | | | | |
