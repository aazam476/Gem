# Human Tests

Things an agent cannot verify in a container: a real phone, camera, microphone, speaker,
live API keys, and Gemini's accuracy on real scenes. (The web build was driven in headless
Chromium with a fake camera earlier; the typed-question box has since been removed, so the
answer flow and the mic can only be tested on a phone.) Run these once per phase; record results in the
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
| 1.1 | `cd backend && GEM_LIVE_TESTS=1 .venv/bin/pytest tests/test_live.py -s` | 5 passed (incl. recalling a monitor seen 60 s earlier, and answering from an uploaded PDF manual). Gemini reads the synthetic BP fixture (128/82) and the assistant test answers mentioning 128 with at least one box. "Model not found" → fix `GEMINI_MODEL` / `GEMINI_ASSISTANT_MODEL`. |
| 1.2 | `curl localhost:8000/health` | `"ai_mode":"gemini"`, `"voice_enabled":true` |

## 2. Gem assistant on a phone (Expo Go)

| # | Steps | Expected |
|---|-------|----------|
| 2.1 | Fresh install (or delete Expo Go's camera/mic permissions), open the app. | "Gem needs your camera and microphone" screen listing both as **Not allowed**. |
| 2.2 | Tap "Allow camera and microphone", allow camera, **deny** microphone. | Still on the permission screen; Camera: Allowed, Microphone: Not allowed. |
| 2.3 | iOS: deny again until "Open Settings" appears (or deny in Settings). Tap it, enable the mic, return to the app. | Settings opens; on return the app goes straight to the camera (no restart). |
| 2.4 | With both granted. Watch the preview for 20 s while moving the phone slowly. | Full-screen back camera with a "Listening" capsule. The preview stays smooth: **no jitter or freeze once a second** (frames are taken at ~1080p). Backend log shows a frame about every second. |
| 2.5 | Point at the BP monitor, say "What does my blood pressure say?" and stop talking. | "Hearing you…" while talking; ~1 s after you stop: "Thinking…"; then the overlay with **your photo with a yellow box** on the display, the answer in the text box, and an **ElevenLabs voice** reading it. Note time from end of speech to voice. |
| 2.6 | While Gem is speaking, talk over it ("wait, stop"), tap the table, cough. | Gem keeps talking to the end (no interrupting); nothing you said while it spoke is sent. The answer sheet says "Gem is speaking — ask your next question when it finishes". |
| 2.6a | Idle on the camera screen in a normal room for 2 minutes with background noise (typing, kitchen, footsteps) but nobody talking to Gem. | Status stays "Listening"; no "Thinking…" cycles. |
| 2.6b2 | iPhone: ask something, let Gem finish, then **immediately** ask a follow-up (half a second after it stops). | Heard right away ("Hearing you…"). Expo terminal shows `[gem-mic] stream paused while Gem speaks`, then `[gem-mic] stream started` as Gem finishes. |
| 2.6f | **Mute:** tap the round mic button (top right), then ask a question out loud and stop talking. | Button turns into a red slashed mic, status "Muted"; nothing happens (no "Hearing you", no "Thinking"), backend log shows no `/turns` request. Tap again: white mic, "Listening", and the next question is answered. |
| 2.6g | Start a question, tap mute in the middle of the sentence, finish it, wait 3 s, unmute. | Nothing is sent; Gem does not answer the half sentence. |
| 2.6h | With an answer on screen, tap mute. | The button is still visible above the answer; the sheet says "Muted — tap the microphone to ask a follow-up." |
| 2.6c | **Correction:** ask "Where is the yellow chair?" with two yellow chairs in view; after Gem finishes, say "No, the other chair." | The new answer boxes the **other** chair. |
| 2.6e | **If Gem doesn't react to your voice at all:** watch the Expo terminal for `[gem-mic]` lines while you talk. | Every 5 s: `N buffers, loudest X dB, noise floor Y dB`. While you talk, loudest should be ≥ 15 dB above the floor, followed by `speech started` and `utterance … ms`. Report the lines: 0 buffers = the stream isn't running; low loudest = too quiet; `dropped … not enough voiced speech` = voice check too strict. |
| 2.6d | On the answer screen (Gem finished), ask a follow-up without tapping anything. | Answered; the new answer replaces the old one. "Frames sent" did **not** increase while the answer screen was up. |
| 2.6b | If you hear nothing: watch the `npx expo start` terminal for `[gem-audio]` lines. | Expected sequence: `downloaded <turn> <bytes>` → `playing <turn>` → `finished <turn>`. `download failed` / `player never started` mean it fell back to the phone voice; report the line. |
| 2.7 | Tap "Read again" 5 times in a row (waiting for each to finish), then once while Gem is still speaking. | The same ElevenLabs voice plays every time, starting from the beginning — never the phone's own voice, never silence (regressions: replays were silent; every other replay used the phone voice). Backend log shows only one ElevenLabs request for that answer (second GET returns `X-Gem-Audio-Cache: hit` if a new player was needed). |
| 2.8 | Tap "Dismiss", then ask another question. | Overlay closes, "Frames sent" starts increasing again, "Mic on", and the new question is answered (repeat 3–4 cycles). |
| 2.9 | Ask a follow-up that depends on context: "Which button starts it?" | Answer refers to the same device; the start button is marked. |
| 2.9b | **Visual memory:** point at a backpack (or any distinct object) for 2–3 s, then point the camera elsewhere and move around for ~1 minute. Ask "Where did I leave my backpack?" | The answer image is the **earlier** frame with the backpack boxed, labelled "Seen about 60 seconds ago"; the spoken answer says roughly when/where. Note latency vs. 2.5. |
| 2.9c | Same, but wait > 5 minutes before asking. | Gem says it doesn't remember / can't see it (memory window is 5 min). |
| 2.10 | Have someone talk nearby / play a TV, without addressing Gem. | Mostly nothing happens or "I didn't catch that." — no spoken answer. |
| 2.11 | Quiet room vs. noisy room (fan, kitchen). Ask a question in each. | End of speech is detected in both; no endless "Hearing you…". If it triggers on noise or cuts you off, note the room and phone model (tune `src/logic/vad.ts` thresholds). |
| 2.13 | iPhone ringer switch on silent; ask a question. | Voice still audible through the speaker (not the earpiece). |
| 2.14 | Background the app for a few seconds, come back, ask again. | Frames and mic resume; answer works. |

## 2b. Inactivity

| # | Steps | Expected |
|---|-------|----------|
| 2b.1 | Put the phone face-up on a table, camera at a still scene, stay quiet for 70 s. | After ~60 s the camera dims: "Paused — Move your phone or speak to wake Gem"; status capsule says "Paused"; backend log shows no more frames. |
| 2b.2 | Pick the phone up. | Banner disappears within a second; frames resume. |
| 2b.3 | Leave it paused, then just speak a question. | It wakes and answers. |
| 2b.4 | Hold the phone still but wave your hand in front of the camera (before 60 s pass). | Stays active (scene change counts). |
| 2b.5 | Leave it still for 10+ minutes, then pick it up and ask "What did you see before?" | Banner said "Gem is asleep"; after waking, Gem has no memory of earlier frames (new session); backend log shows the old session ended. |

| 2b.6 | In the portal set "Pause camera after" 0.5 min and "Forget conversation after" 2 min, Save. Restart the Gem app, stay still. | Paused after ~30 s; "Gem is asleep" after ~2 min. Set back to 1 / 10 afterwards. |

## 2c. Study documents (portal + phone)

| # | Steps | Expected |
|---|-------|----------|
| 2c.1 | Portal → "Gem study context": add a note ("Patients use an Omron M7 on the left arm; rest 5 minutes first"), upload the device's PDF manual and a photo of the device. | All three listed; PDF/photo show "uploading to Gemini…" then "ready for Gem" within a few seconds (with a Gemini key). |
| 2c.2 | Restart the Gem app (new session), ask "How long should I rest before measuring?" | Answer uses the note/manual ("rest five minutes…"). |
| 2c.3 | Point at the device and ask "Which button do I press first?" | Answer matches the manual; the button is boxed. Note latency vs. without documents. |
| 2c.4 | Remove the note in the portal, start a new session, ask again. | Gem no longer cites it. |
| 2c.5 | Try uploading a .docx and a 30 MB PDF. | Clear error messages; nothing added. |

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

| # | Steps | Expected |
|---|-------|----------|
| 5.1 | Open Gem. | Only the camera, a "Listening" capsule at the top and the hint "Point at something and ask a question." No frame counts, change scores or "Mic on". |
| 5.2 | Ask a question. | Capsule shows a spinner + "Thinking" and your question in quotes; the answer sheet springs up from the bottom (no bounce past the top). |
| 5.3 | Drag the photo on the answer sheet down and let go past a third of the screen; repeat with a short fast flick. | Both dismiss and listening resumes. A small drag springs back. Dragging up stretches slightly and springs back. |
| 5.4 | Settings → Accessibility → Motion → Reduce Motion on, ask again. | The answer sheet fades in/out instead of sliding. |
| 5.5 | Turn Wi-Fi off. | A card "I'm having trouble connecting…" with "Try again" at the bottom. |
| 5.6 | Settings → Display & Brightness → Dark, then reopen Gem (permission screen if not yet granted) and ask a question. | Permission screen and answer sheet are dark with light text; the camera chrome looks the same; the status bar stays white over the camera. Switching back to Light updates without restarting. |

## 6. Optional

- `cd backend && .venv/bin/python scripts/generate_fallback_audio.py`: bundles ElevenLabs
  clips of the fixed lines (offline network-error line).
- Load test for the legacy gateway numbers:
  `cd backend && .venv/bin/python load_test.py --workers 50 --events 1000`.

## Results log

| Date | Tester | Section | Pass/Fail | Notes (device, OS, timings) |
|------|--------|---------|-----------|-----------------------------|
| | | | | |
