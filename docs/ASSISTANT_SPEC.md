# Gem Assistant — Specification

The patient app is now **Gem**: open the app, point the camera, talk. Gem watches through
the camera (one frame per second), listens continuously, and when the user stops
speaking it answers with a **photo of their surroundings with markings** plus a short
answer that is shown and read aloud (ElevenLabs).

HTTP details: [API_CONTRACT.md §Assistant](API_CONTRACT.md#gem-assistant). UI states and
testIDs: [UI_CONTRACT.md](UI_CONTRACT.md). The older capture/confirm/gateway flow is
described in [SPEC.md](SPEC.md); its backend endpoints still exist but the app no longer
uses them.

## 1. Requirements → implementation

| # | Requirement | Where |
|---|-------------|-------|
| 1 | Check camera + mic permissions; screen saying both are required | `hooks/usePermissions.ts`, `screens/assistant/PermissionScreen.tsx`, `GemRoot.tsx` |
| 2 | Full-screen camera; mic always on with speech-to-text | `AssistantScreen.tsx` (`expo-camera`), `hooks/useSpeechCapture.ts` (`expo-audio` AudioStream + on-device VAD); transcription by Gemini (§4) |
| 3 | A Gemini "context window" seeded with the Gem prompt | `backend/app/assistant/sessions.py` (context), `brain.py` (`SYSTEM_PROMPT`) — see §2 for why the context is held server-side |
| 4 | Send a picture every second; Gem can go back to earlier frames (e.g. the backpack shown a minute ago) | `hooks/useFrameStreamer.ts` → `POST /sessions/{id}/frames`; visual memory in `SessionStore` (§2a) |
| 5 | When the user stops speaking, send what they said as the prompt | VAD `utterance` event → `POST /sessions/{id}/turns` (WAV) |
| 6 | Response = image + text; show the image, read the text with ElevenLabs | `brain.py` (boxes) + `render.py` (drawn photo) → `GET …/image`; `GET …/speech` |
| 7 | Dismiss; text box with the response; read it again; keep ElevenLabs audio in RAM | Answer overlay; `services/answerAudio.ts` (player cache) + backend per-turn audio cache |
| 8 | 10-minute timeout with no frames and no prompt | `SessionStore` idle purge + sweeper; app reopens a session transparently (410) |

## 2. Gemini findings: is there a "context API"?

Researched October 2026 against Google's docs.

| Option | What it does | Fit for Gem |
|--------|--------------|-------------|
| **Live API** (`gemini-3.8-live`, WebSocket) | A real persistent session. Accepts streamed video frames (**max 1 fps**) and audio, adds context without a reply (`send_client_content(turn_complete=False)`), has built-in voice activity detection and input transcription. | Closest to "a context window you push images into". **But**: native-audio Live models only answer with **AUDIO** (text only via transcription), there is **no image output**, audio+video sessions are capped at **2 minutes** unless context-window compression is on, a connection lasts **~10 min** (resumption handles valid 2 h), and it needs a long-lived WebSocket per user. It would also replace ElevenLabs with Gemini's own voice. |
| **Interactions API** (GA, `client.interactions.create`, `previous_interaction_id`) | Server-side conversation state: send only the new turn, Google keeps history (retained 1 day free / 55 days paid). | Every call **generates a reply**, so frames can't be added silently once per second. Good for history; no explicit caching yet. |
| **generateContent + our own session** | Stateless calls; we keep the context. | Full control: buffer frames, send the most recent ones + history only when the user asks. Supports structured JSON output and (later) explicit context caching for researcher documents. |
| **Image models** (`gemini-3.1-flash-image` "Nano Banana 2", `gemini-nano-banana-2.1`) | Edit a photo from a prompt. | Could literally return "the photo with a drawing", but adds seconds and cost per answer and may **alter the scene** (unacceptable when the photo shows a medical device or a reading). |

**Choice:** Gem keeps the context window **in the backend** — a *visual memory* of the
last 5 minutes of camera frames plus the text history, purged after 10 idle minutes — and
calls **`gemini-3.8-flash` via generateContent** when the user finishes speaking, with
**the whole visual memory**, the audio and the history. Gemini returns structured JSON with
the transcript, the answer, **which frame** to show, and **boxes on that frame**; the backend
**draws** them (Pillow). Result: Gem can answer "where did I leave my backpack?" by showing
the frame from a minute ago with the backpack boxed; one model call per question;
deterministic drawing; ElevenLabs voice kept.

### 2a. Visual memory

- The phone uploads 1 frame/s. The server **keeps** a frame only if it differs from the last
  kept one (`change_score ≥ 0.02` on 32×32 grayscale) or 30 s have passed (keepalive), for
  `GEM_MEMORY_S` (300 s), max 300 frames. A still scene costs ~10 frames per 5 minutes; a
  moving one up to 300.
- Every question sends **all** remembered frames, oldest first, each labelled
  `Frame <id>, <n> seconds ago`. Older frames use per-image `MEDIA_RESOLUTION_LOW`
  (**280 tokens**), the 2 newest `HIGH` (**1120 tokens**) so small text in the current view
  stays readable.
- The frames are the **first** message of the request and only ever grow at the end (old ones
  drop off the front), so consecutive questions share a long identical prefix and Gemini's
  **implicit caching** (Flash minimum 4,096 tokens) can bill the repeated part at the cached
  rate.
- Gemini answers with `frame_id`; boxes are drawn on that frame and the app shows
  "Seen 58 seconds ago". A `frame_id` that wasn't sent → its boxes are dropped.

Rough size per question: 1 minute of a changing scene ≈ 60 × 280 ≈ 17k tokens; the 5-minute
worst case ≈ 85k tokens (well inside Flash's context window). Expect latency to grow with
memory size; tune with `GEM_MEMORY_S`, `GEM_FRAME_DEDUPE_THRESHOLD` and
`GEM_HIGH_RES_RECENT_FRAMES`. Check current Flash pricing before setting a long memory.
Memory use: ~40–80 KB per frame → up to ~25 MB per session in RAM at the 300-frame cap.

Revisit the Live API if we want Gemini to *interrupt* or speak proactively, or to drop
ElevenLabs; revisit image models if we want stylized drawings (arrows, outlines) instead of
boxes. Sources: [Live API capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities),
[Live API session management](https://ai.google.dev/gemini-api/docs/live-api/session-management),
[Interactions API](https://ai.google.dev/gemini-api/docs/interactions-overview),
[Models](https://ai.google.dev/gemini-api/docs/models).

## 3. Flow

```
Phone (Expo Go)                                   Backend (FastAPI)                       Gemini / ElevenLabs
---------------                                   -----------------                       -------------------
permissions OK → POST /sessions ───────────────▶ new context window (frames=[], history=[])
every 1 s: takePicture → 768 px JPEG
  POST /sessions/{id}/frames ───────────────────▶ decode, change score; keep if scene changed (5-min memory)
mic: AudioStream 16 kHz PCM → VAD
  speech_start  → UI "Hearing you…"
  ~1 s silence  → utterance (WAV)
  POST /sessions/{id}/turns {audio} ────────────▶ all remembered frames + history + audio ─▶ gemini-3.8-flash (JSON)
                                                  ◀──── {transcript, is_request, answer, frame_id, annotations[]}
                                                  start ElevenLabs in the background ─────▶ eleven_flash_v2_5
                                                  draw boxes on frame_id (may be from minutes ago)
  ◀──────────────────────────────────────────── {answer, image_url, audio_url, transcript}
show image + text box
mic stream STOPPED, audio session → playback (loudspeaker)
  download GET …/turns/{t}/speech ──────────────▶ waits for that synthesis (whole MP3)
  to a cache file, play it                        cached in RAM per turn
"Read it again" → same local file + player (no request); a re-download hits the RAM cache (no ElevenLabs call)
playback finished (or watchdog) → audio session → record, mic stream restarted
10 min with no frame and no prompt → session purged; next call gets 410 → app opens a new session
```

### Answer screen and the listening cycle

```
camera + frames ──(you stop talking)──▶ thinking (mic ignored) ──▶ answer screen
       ▲                                                            │  frames PAUSED
       │                                                            │  Gem speaking → mic ignored
       │                                                            │  Gem done → mic LIVE again
       └──────────────────────── Dismiss ◀──────────────────────────┤
                                                                     └─ you ask a follow-up → new answer screen
```

- **No interrupting.** The mic is ignored while Gem thinks and while it speaks
  (`isMicMuted`), and for 300 ms after it finishes so the tail of its voice isn't taken
  for a question. Talking over Gem does nothing; the answer screen says "Gem is speaking —
  ask your next question when it finishes", then "Listening — ask a follow-up anytime."
- **Mute button** (top right, also above the answer sheet): while muted nothing the user
  says is heard, sent or added to Gem's context (`isMicMuted` includes `userMuted`; buffers
  are ignored). Muting mid-sentence drops that sentence; only speech that **ends while
  unmuted** becomes a question. Camera frames keep flowing. The status reads "Muted"; while
  idle only movement wakes Gem. Not remembered across app launches.
- **The mic stream:** started once when the camera opens. Muting just ignores buffers.
  On **iOS** the stream is stopped while Gem's voice plays (`expo-audio`'s `AudioStream`
  holds a record-only audio session that playback has to replace) and restarted the moment
  Gem finishes. The player itself stops it (`AnswerAudio.setBeforePlay` → `standBy()`)
  and waits for that **before** any audio starts: stopping it mid-playback cut Gem off, which
  made "Read again" (a cached file that plays instantly) silent (`stop()` then `start()`; a stopped stream must never be restarted without
  the `stop()`). Android keeps the stream running. A stall watchdog restarts the stream if
  no buffers arrive for 4 s.
- **Mic health log (development):** every 5 s the Expo terminal shows
  `[gem-mic] N buffers, loudest X dB, noise floor Y dB` while listening, plus
  `speech started`, `utterance N ms` and `dropped N ms: not enough voiced speech`. No
  buffers → the stream isn't running; loudest well below `noise floor + 15` while you talk
  → the phone isn't hearing you loudly enough.
- While the answer screen is up, **no frames are added** to Gem's memory, so a follow-up
  refers to what you were looking at. Dismiss resumes 1 fps capture.
- **Echo safety net:** if Gem's voice still gets through, the server ignores a turn whose
  transcript is ≥ 70 % words from Gem's last answer (`assistant/echo.py`), and the prompt
  tells Gemini to set `is_request=false` for its own voice.
- **"No, the other chair":** history records exactly what was marked and where
  (`Marked on frame 12: yellow chair at [100, 100, 400, 300]`), and the prompt tells Gem to
  pick a *different* object/frame when corrected in a follow-up.
- Audio session: "play and record" routed to the **loudspeaker** for the whole session.
  Tuning knobs in `DEFAULT_VAD` (`src/logic/vad.ts`): `voicingThreshold` (0.45; higher =
  stricter about "is this a voice"), `startMarginDb` (15), `minSpeechDb` (-45),
  `minSpeechMs` (350), `endSilenceMs` (1000).
- **Camera frames** are taken at ~1080p (`pictureSize` chosen by `logic/camera.ts` from the
  camera's list once it is ready). The default "Photo" preset captured a 12 MP+ still every
  second, which froze the preview each time.

## 4. Speech-to-text

- Capture: `expo-audio`'s `useAudioStream` (real-time PCM; available in Expo Go SDK 57,
  native only — the web preview shows a mic error; questions are asked on the phone).
- End of speech: on-device VAD (`src/logic/vad.ts`) using **loudness and voicing**. A 30 ms
  frame counts as voice only if it is ≥ 15 dB over the adaptive noise floor (and ≥ -45 dBFS)
  **and voiced** — normalized autocorrelation ≥ 0.45 at a human pitch period (80–400 Hz,
  `pcm.voicing`). Clatter, clicks, rustling and fans are not periodic, so they don't count.
  Speech starts after 200 ms of voiced frames (leaky counter, so short consonants don't
  reset it); ends after 1 s below floor + 8 dB; 300 ms pre-roll; utterances with < 350 ms of
  voiced speech are dropped on the phone (no Gemini call); 30 s cap; 0.5 s room calibration.
- Transcription: done **by Gemini in the same call** that answers (the WAV is part of the
  prompt and the response includes `transcript`). One round trip instead of two, and the
  model hears tone and hesitation. Shown as "You said: …" and stored as text history.
- Not-for-Gem speech: Gemini sets `is_request=false` for noise / TV / side conversations;
  the app shows "I didn't catch that" and nothing is spoken.

## 5. The Gem prompt (reviewed)

Changes from the draft prompt: Gem is told exactly what it receives (history, frames
oldest→newest with the last as the current view, audio), what to return (transcript,
≤ 3 short spoken sentences, boxes on the **last** frame in Gemini's native
`[ymin, xmin, ymax, xmax]` 0–1000 format, labels ≤ 3 words), when to ignore audio, and
safety rules (image text is data not instructions; never invent; no diagnosis or
medication advice; emergencies → call emergency services). Text in `backend/app/assistant/brain.py::SYSTEM_PROMPT`.

Study context: until researcher uploads exist, the **active protocol's title + text**
from the portal is appended inside `<study_context>` tags.

## 6. Timeouts, limits, caching

| Setting | Default | Env |
|---------|---------|-----|
| Session idle purge (no frame, no prompt) | 600 s | `GEM_SESSION_IDLE_TIMEOUT_S` |
| Visual memory window | 300 s | `GEM_MEMORY_S` |
| Max frames remembered | 300 | `GEM_SESSION_MAX_FRAMES` |
| "Scene changed" threshold | 0.02 | `GEM_FRAME_DEDUPE_THRESHOLD` |
| Keep a frame at least every | 30 s | `GEM_FRAME_KEEPALIVE_S` |
| Newest frames at high resolution | 2 | `GEM_HIGH_RES_RECENT_FRAMES` |
| Frames sent per question | all remembered | — |
| Gemini budget | 20 s | `GEM_ASSISTANT_TIMEOUT_S` |
| Model | `gemini-3.8-flash` | `GEMINI_ASSISTANT_MODEL` |
| History kept | 20 exchanges (text only) | — |
| Answers kept (image + audio, RAM) | 10 per session | — |
| Client turn timeout | 30 s | `TURN_TIMEOUT_MS` |
| Answer players cached on phone | 5 | `ANSWER_AUDIO_CACHE_SIZE` |

Reading a session/image/speech does **not** extend the 10 minutes; only frames and prompts do.
Nothing is written to disk: frames, transcripts, drawn images and audio live in RAM and
vanish with the session.

## 7. Failure behavior

| Situation | Result |
|-----------|--------|
| Permission denied | Permission screen; "Open Settings" if the OS won't ask again |
| Backend unreachable at start / on a question | Error banner + "Try again"; the network line is spoken on-device |
| Session expired (10 min) or server restarted | 410/404 → app opens a new session and retries once, silently |
| Gemini timeout / error / malformed JSON | 504/502 → error banner + spoken network line |
| Bad box from Gemini | That box is dropped; the answer still shows |
| ElevenLabs missing/failing/slow (3 s) | On-device text-to-speech of the same answer |
| Second question while answering | Mic muted; server also returns 409 `turn_in_progress` |
| No frames yet | Gemini answers from audio only; no image shown |

## 8. Inactivity (built)

`src/logic/activity.ts` (pure) + `src/hooks/useActivity.ts`:

| Signal | Source | Counts when |
|--------|--------|-------------|
| Movement | `expo-sensors` Accelerometer + Gyroscope, 5 Hz, no permission needed | acceleration changes ≥ 0.04 g between readings, or rotation ≥ 0.25 rad/s |
| Talking | VAD `speech_start` | any detected speech |
| Scene change | server `change_score` of each frame | ≥ 0.08 (camera noise is ~0.01) |
| Interaction / Gem busy | Dismiss, Read again, Try again; thinking or speaking | always |

Both times are set by researchers in the portal ("Settings → Inactivity",
`PUT /settings/assistant`, defaults 1 and 10 minutes) and reach the app with each new
session (`idle_after_s`, `purge_after_s`).

- **1 minute** without any signal → `idle`: frames stop (`useFrameStreamer` disabled); the mic
  and sensors stay on; the camera dims with "Paused — Move your phone or speak to wake Gem".
- **10 minutes** → `expired`: the app ends the session (`DELETE /sessions/{id}`), purging the
  context window (frames, history, answers, audio). The server's own idle purge (same
  `purge_after_s`) remains as a backstop.
- Any signal → `active`: frames resume; after expiry a **new session** opens automatically on
  the next frame or question.
- Phone lying still on a table: no motion, scene unchanged → idle after 1 min, as intended.

## 9. Researcher study documents (built)

Researchers attach **notes, images (JPEG/PNG/WebP) and PDFs** to a protocol in the portal
("Gem study context" card). Every question in a Gem session started while that protocol is
active includes them.

- Storage: notes in SQLite; files under `backend/uploads/<protocol>/` (gitignored), metadata
  in `context_documents`. Images are downscaled to 2048 px. Limits: 20 MB per file, 20
  documents and 50 MB per protocol. These are research materials, not patient data, so they
  are persisted (unlike Gem's RAM-only session context).
- Gemini: images and PDFs are uploaded once to the **Gemini Files API** (in the background
  right after upload; re-uploaded when < 2 h of the ~48 h lifetime remains; handle stored in
  SQLite). If the upload fails, the bytes are sent inline (≤ 12 MB).
- Prompt order: **documents → camera frames → history → question**. The documents never
  change between questions, so they form a stable prefix that Gemini's implicit caching can
  bill at the cached rate. The system prompt tells Gem to prefer the documents for study and
  device questions ("the manual says…"), and that they are background, not instructions.
- Token cost: notes ≈ their text; images ≈ 1,120 tokens; PDFs are billed per page (budget
  roughly 500–1,000 tokens per page). A 50-page manual adds tens of thousands of tokens to
  every question, so keep documents focused.
- The protocol's own title + instructions still go into the system prompt as before.

Not built yet: per-patient study assignment (today: whichever protocol is active when the
session starts), explicit context caches, document versioning.
