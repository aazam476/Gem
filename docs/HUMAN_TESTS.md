# Human Tests

Things an agent cannot verify in a container: a real phone, camera, microphone, speaker,
live API keys, and Gemini's accuracy on real scenes. (The web build was driven in headless
Chromium with a fake camera earlier; the typed-question box has since been removed, so the
answer flow, barge-in and the mic can only be tested on a phone.) Run these once per phase; record results in the
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
4. **Fixtures.** A real device to ask about (e.g. an upper-arm BP monitor), in a quiet and a noisy room.
5. **No LAN?** If phone and laptop can't see each other, use a VPN both are on (e.g. WireGuard:
   `EXPO_PUBLIC_API_URL=http://<laptop-vpn-ip>:8000` and
   `REACT_NATIVE_PACKAGER_HOSTNAME=<laptop-vpn-ip> npx expo start`), or tunnels
   (`cloudflared tunnel --url http://localhost:8000` + `npx expo start --tunnel`).

Start everything:
```bash
cd backend && .venv/bin/uvicorn app.main:get_app --factory --host 0.0.0.0 --port 8000
cd mobile && npx expo start          # w = portal in browser; scan QR in Expo Go = patient app
```

## 1. Live API checks (laptop only)

| # | Steps | Expected |
|---|-------|----------|
| 1.1 | `cd backend && GEM_LIVE_TESTS=1 .venv/bin/pytest tests/test_live.py -s` | 4 passed (incl. recalling a monitor seen 60 s earlier). Gemini reads the synthetic BP fixture (128/82) and the assistant test answers mentioning 128 with at least one box. "Model not found" → fix `GEMINI_MODEL` / `GEMINI_ASSISTANT_MODEL`. |
| 1.2 | `curl localhost:8000/health` | `"ai_mode":"gemini"`, `"voice_enabled":true` |

## 2. Gem assistant on a phone (Expo Go)

| # | Steps | Expected |
|---|-------|----------|
| 2.1 | Fresh install (or delete Expo Go's camera/mic permissions), open the app. | "Gem needs your camera and microphone" screen listing both as **Not allowed**. |
| 2.2 | Tap "Allow camera and microphone", allow camera, **deny** microphone. | Still on the permission screen; Camera: Allowed, Microphone: Not allowed. |
| 2.3 | iOS: deny again until "Open Settings" appears (or deny in Settings). Tap it, enable the mic, return to the app. | Settings opens; on return the app goes straight to the camera (no restart). |
| 2.4 | With both granted. | Full-screen back camera; status "Listening — ask me anything"; "Mic on"; "Frames sent" counts up ~1 per second. |
| 2.5 | Point at the BP monitor, say "What does my blood pressure say?" and stop talking. | "Hearing you…" while talking; ~1 s after you stop: "Thinking…"; then the overlay with **your photo with a yellow box** on the display, the answer in the text box, and an **ElevenLabs voice** reading it. Note time from end of speech to voice. |
| 2.6 | While Gem is speaking, keep quiet (phone volume at your normal level), then make non-speech noise: tap the table, rustle paper, close a door, cough once. | Gem keeps talking; no "Thinking…" afterwards. If background sounds still interrupt it, raise `voicingThreshold` (e.g. 0.55) or `bargeInHoldMs` in `src/logic/vad.ts`; if Gem's own voice interrupts it, raise `bargeInMarginDb`. |
| 2.6a | Idle on the camera screen in a normal room for 2 minutes with background noise (typing, kitchen, footsteps) but nobody talking to Gem. | Status stays "Listening"; no "Thinking…" cycles. |
| 2.6c | **Interrupt:** ask "Where is the yellow chair?" with two yellow chairs in view; while Gem is still talking, say "Wait, no, the other chair." | Gem stops talking within ~0.5 s of you starting; "Hearing you…" on the answer screen; the new answer boxes the **other** chair. If it doesn't react, note the volume; lower `bargeInMarginDb`. |
| 2.6d | On the answer screen (Gem finished), ask a follow-up without tapping anything. | Answered; the new answer replaces the old one. "Frames sent" did **not** increase while the answer screen was up. |
| 2.6b | If you hear nothing: watch the `npx expo start` terminal for `[gem-audio]` lines. | Expected sequence: `downloaded <turn> <bytes>` → `playing <turn>` → `finished <turn>`. `download failed` / `player never started` mean it fell back to the phone voice; report the line. |
| 2.7 | Tap "Read it again" twice. | Same voice plays again immediately. Backend log shows only one ElevenLabs request for that answer (second GET returns `X-Gem-Audio-Cache: hit` if a new player was needed). |
| 2.8 | Tap "Dismiss", then ask another question. | Overlay closes, "Frames sent" starts increasing again, "Mic on", and the new question is answered (repeat 3–4 cycles). |
| 2.9 | Ask a follow-up that depends on context: "Which button starts it?" | Answer refers to the same device; the start button is marked. |
| 2.9b | **Visual memory:** point at a backpack (or any distinct object) for 2–3 s, then point the camera elsewhere and move around for ~1 minute. Ask "Where did I leave my backpack?" | The answer image is the **earlier** frame with the backpack boxed, labelled "Seen about 60 seconds ago"; the spoken answer says roughly when/where. Note latency vs. 2.5. |
| 2.9c | Same, but wait > 5 minutes before asking. | Gem says it doesn't remember / can't see it (memory window is 5 min). |
| 2.10 | Have someone talk nearby / play a TV, without addressing Gem. | Mostly nothing happens or "I didn't catch that." — no spoken answer. |
| 2.11 | Quiet room vs. noisy room (fan, kitchen). Ask a question in each. | End of speech is detected in both; no endless "Hearing you…". If it triggers on noise or cuts you off, note the room and phone model (tune `src/logic/vad.ts` thresholds). |
| 2.13 | iPhone ringer switch on silent; ask a question. | Voice still audible through the speaker (not the earpiece). |
| 2.14 | Background the app for a few seconds, come back, ask again. | Frames and mic resume; answer works. |

## 3. Failure behavior on a phone

| # | Steps | Expected |
|---|-------|----------|
| 3.1 | Stop the backend, ask a question. | Within ~30 s: "Connection problem" + "Try again"; the phone itself says "I'm having trouble connecting…". Restart backend → Try again → listening. |
| 3.2 | Backend with `ELEVENLABS_API_KEY=` (empty), ask a question. | Answer read with the phone's built-in voice, no long silence. |
| 3.3 | Backend with `GEM_SESSION_IDLE_TIMEOUT_S=60`, put the phone face down (frames keep coming → not idle). Then lock the phone for 90 s, unlock, ask a question. | The question still works (the app opens a new session silently after the 410). |
| 3.4 | Cover the lens and ask "What do you see?" | Gem says it can't see / it's too dark; no misleading markings. |
| 3.5 | Offline demo: `GEM_MOCK_AI=1`, no keys. | Spoken questions get the mock answer with a box in the middle and on-device voice. |

## 4. Accuracy sample

Ask 10 questions about real objects/devices (readings, buttons, labels) in different
lighting. Record: correct answer? box on the right thing? latency. Target: ≥ 8/10 useful
answers, boxes on target, no invented readings.

## 5. UI smoke (after the restyle)

Run 2.1, 2.4, 2.5, 2.6c, 2.7, 2.8 and 3.1 again, then `cd mobile && npm test`. Check text
≥ 20 px, large buttons, and the answer image shows the markings uncropped.

## 6. Optional

- `cd backend && .venv/bin/python scripts/generate_fallback_audio.py`: bundles ElevenLabs
  clips of the fixed lines (offline network-error line).
- Load test for the legacy gateway numbers:
  `cd backend && .venv/bin/python load_test.py --workers 50 --events 1000`.

## Results log

| Date | Tester | Section | Pass/Fail | Notes (device, OS, timings) |
|------|--------|---------|-----------|-----------------------------|
| | | | | |
