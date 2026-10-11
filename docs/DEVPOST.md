# Devpost write-up (paste-ready)

Re-check the test counts and gateway latencies against a final run on the demo laptop
(`./scripts/check.sh`, `backend/.venv/bin/python load_test.py --workers 50 --events 1000`)
before submitting.

---

## Project name
**Gem 💎**

## Elevator pitch
FaceTime a friend who has perfect memory, has read your entire clinical trial manual, and never sighs when you ask where the start button is for the fourth time. Point your phone, ask out loud, and Gem circles the answer on a photo and says it back to you.

---

## Inspiration
Decentralized clinical trials are a great idea on paper: patients take part from home, with no 90-minute drive to a research site. In practice that means a 74-year-old alone with a blood pressure cuff, a 40-page PDF manual, and a sticky note that says "CALL STUDY COORDINATOR (business hours only)." People drop out, readings get typed in wrong, and the data quietly gets worse.

We kept asking: what if you could just *FaceTime someone who knows*? Someone who can see what you see, who you can talk to like a person, and who will literally draw a circle around the thing you're looking for. Then we realized we could build that someone, and it would never be on lunch break.

## What it does
**For patients:** open the app and it's just your camera, like a video call with an expert who happens to be a gemstone.
- **Always listening:** no button to hold. Ask "Which one is the start button?" and Gem hears when you've finished talking.
- **Sees what you see:** a frame goes to Gem's memory every second while the camera is up, about the rate of a slow video call.
- **Remembers what you showed it:** Gem keeps a 5-minute visual memory. "Where did I put the cuff?" gets the frame from 58 seconds ago with the cuff circled, labelled *"Seen 58 seconds ago."*
- **Answers with a marked-up photo and a voice:** a warm ElevenLabs voice reads the answer aloud, and an answer sheet slides up with the annotated photo and the text. You can tap Read again, or drag it away and keep going.
- **Polite about privacy:** put the phone down and Gem pauses the camera after a minute. After ten minutes it forgets the whole conversation; nothing from the camera or mic is ever written to disk.

**For researchers:** a web portal where they:
- upload the study's context: notes, device photos and PDF manuals. Gem reads them before answering, so it knows *your* Omron M7, not blood pressure cuffs in general;
- set the inactivity timings;
- manage protocols;
- watch device readings flow through a deterministic validation gateway that checks every value in microseconds and refuses anything an AI may have hallucinated. A systolic of 900 is not "flagged for review"; it is rejected outright.

## How we built it
**Architecture:** one Expo SDK 57 codebase (React Native 0.86, React 19.2, TypeScript 6). The native build is the patient app; the web build is the researcher portal. Behind it is a Python 3.13 / FastAPI 0.143 / Pydantic 2 backend holding Gem's context window in RAM, with SQLite (WAL mode) for protocols, documents and settings. API keys live only on the server; the phone bundle has no secrets.

**Gem's context window is something we built ourselves.** Gemini has no "keep pushing images into a session" API that fits:
- The **Live API** answers only in audio, can't output images, caps audio+video sessions at about 2 minutes without compression, and would replace our ElevenLabs voice.
- The **Interactions API** generates a reply for every input, so frames can't be added silently.

So the server owns the session:
- **Visual memory:** a deque of JPEG frames with a per-frame `change_score`. Each frame is reduced to 32×32 grayscale and compared to the last kept one (mean absolute difference). Frames below 0.02 are dropped, with a 30-second keepalive frame even when nothing changes. Frames older than 300 seconds are evicted.
- **One request per question.** Each question is a single `generateContent` call to `gemini-3.8-flash` with `response_json_schema`, ordered for implicit prompt caching: **documents → frames → history → question**.
- **Image resolution per part:** every frame is sent at `MEDIA_RESOLUTION_LOW` (~280 tokens) except the two newest at `HIGH`. Five minutes of memory is roughly a phone book of tokens instead of a phone book of phone books.
- **Speech-to-text happens inside the same Gemini call.** The phone sends 16 kHz mono PCM as a WAV file, and Gemini returns `{transcript, is_request, answer, frame_id, annotations[]}`. That's one round trip for speech recognition, vision and reasoning.
- **Gemini never draws pixels.** It returns `box_2d` in a 0–1000 coordinate grid and the `frame_id` it's referring to. Pillow draws the boxes server-side onto *that* frame. The photo is never altered beyond the markings, which matters when the image shows a medical device.
- **Strict parsing:** `parse_reply` rejects malformed JSON, out-of-range boxes and frame IDs Gemini made up.
- **Corrections work:** history records the exact boxes Gem drew (`[Marked on frame 41: chair at [120, 300, 560, 610]]`), so "no, the *other* chair" can rule out the first one.
- **Study documents:** PDFs and images go to the **Gemini Files API** once (`client.aio.files.upload`) and are referenced with `Part.from_uri`. Notes go inline as `<document>` text. The files live in SQLite plus an uploads folder, separate from the RAM-only patient context.

**Voice:**
- **ElevenLabs** `eleven_flash_v2_5`, synthesized at most once per answer and cached in RAM on the server. The phone downloads the whole MP3 (served with a `Content-Length`) to a cache file and plays it with `expo-audio`, so "Read again" costs $0.
- **The ears:** `expo-audio`'s `useAudioStream` delivers raw PCM into a voice activity detector we wrote in TypeScript (`vad.ts`). Detecting speech requires two things:
  - loudness above an adaptive noise floor;
  - **voicing**: an autocorrelation pitch check over 80–400 Hz with peak correlation ≥ 0.45.

  Speech counts as started after 200 ms and as finished after 1 s of silence, with a minimum of 350 ms of actual voiced speech.
- **Inactivity detection** combines three signals:
  - movement from the `expo-sensors` accelerometer and gyroscope at 5 Hz (≥ 0.04 g or ≥ 0.25 rad/s);
  - detected speech;
  - scene change from the server's `change_score` (≥ 0.08).

  The tracker is pure and unit-tested; the timings come from the portal with each new session.

**UI:**
- **Motion:** Reanimated 4 with worklets and Gesture Handler. The answer sheet enters with a spring (`{duration: 300, dampingRatio: 0.8}`), and the drag-to-dismiss uses velocity projection (`v/1000 · 0.998 / 0.002`) with rubber-banding when dragged upward.
- **Press feedback:** a 0.97 scale over 120 ms using Reanimated CSS transitions on `cubic-bezier(0.23, 1, 0.32, 1)`.
- **Chrome over the camera:** `expo-blur` glass.
- **Light and dark palettes,** with every text color tested for WCAG AA contrast.

**The gateway (legacy capture flow):** `gateway.py` is a pure function with no I/O, no AI and no clock. It checks plausibility limits, cross-field rules (systolic > diastolic) and idempotency, at p50 ≈ 2 µs in-process and ≈ 19 µs through the server. The load test pushes 1,000 events from 50 workers and checks exactly-once storage, with zero invalid readings stored.

**Testing:**
- 171 backend tests and 159 mobile tests.
- Backend tests **block outbound sockets** so nothing secretly calls Gemini, and use scripted fakes in its place.
- Mobile contract tests render every UI state and check each `testID`, so a restyle can't silently disconnect a button.
- Playwright drives the web preview with a fake camera stream.

## Challenges we ran into
**🎤 The mic that wouldn't come back.**
- **Dead after one use:** after the first answer, Gem simply stopped listening. On iOS a stopped `AudioStream` releases its native resources and often refuses to restart.
- **Fix:** start the stream exactly once and **never stop it**. Muting means ignoring buffers (only while Gem is thinking). A stall watchdog restarts the stream if no buffers arrive.

**🔇 ElevenLabs returned `200 OK` and absolutely nothing came out of the speaker.**
- **Cause:** we were streaming chunked MP3 with no length, and iOS's player doesn't handle that well. With the mic open, iOS also stays in record+play mode, which can send audio to the *earpiece*, so Gem was whispering into a phone lying on the table.
- **Fix:** serve the whole MP3 with a `Content-Length`, download it to a local cache file, force loudspeaker output, and add a watchdog in case the player never reports "finished".

**📞 Making it feel like a FaceTime call (and letting you talk over Gem).** A real call lets you interrupt, so we built barge-in: the mic stays live while Gem speaks. Then:
- **Gem kept interrupting itself.** Expo Go has no app-level echo cancellation, so Gem heard its own voice through the speaker and treated it as a new question. Two defences:
  - an echo mode in the VAD that learns how loud Gem sounds and requires +10 dB over that for 450 ms;
  - a server-side echo check that drops any transcript matching ≥ 70% of Gem's last answer.
- **Background noise counted as speech.** A dish clattering = "the user is talking" = Gem stops mid-sentence and starts thinking about nothing. Energy-only detection can't tell a fork from a person, which is why we added the autocorrelation **voicing** check: forks have no pitch.
- **iOS barge-in was impossible as built.** Reading expo-audio's iOS source showed `AudioStream` forces the audio session into `.record` mode, which conflicts with playback. So while Gem talks, we switch to a *second* recorder's level meter (`useAudioRecorder` with metering in play-and-record mode), then hand off to the stream, seeded with the start of your speech.
- **Calibration was off.** One phone log read `user interrupted Gem at 823 ms (echo -48 dB)` when nobody spoke. The echo level had been calibrated on room silence while the answer was still *downloading*. Calibration now only runs once audio is actually audible.
- **Status:** barge-in is parked as "works, but fussy." Full-duplex audio without platform echo cancellation is hard.

**🧠 "Draw a box around the backpack I showed you a minute ago."**
- **Problem:** sending only the newest few frames kept prompts small, but Gem forgot everything after about 3 seconds.
- **Fix:** the deduplicated 5-minute memory, low-resolution old frames, Gemini choosing *which* frame to answer from, and the server drawing on that historical frame.

**🌐 Networking:** no shared LAN between the laptop and the phone. We ran the app over a WireGuard tunnel instead.

**📱 Expo Go constraints:** no native speech-to-text without a custom build, no `expo-av` in SDK 57, and every native module had to be Expo Go-compatible. That's a big part of why transcription moved into the Gemini call.

## Accomplishments that we're proud of
- **One request does it all:** a single Gemini call per question does speech-to-text, scene understanding, document-grounded reasoning, choosing the right frame from 5 minutes of history, and returning drawable boxes.
- **It remembers where you left things.** Ask about something you put down a minute ago and you get a photo from a minute ago with it circled.
- **Privacy by default:** patient context lives only in RAM and is purged after inactivity. The only data written to disk is the researchers' study material.
- **AI can't write bad data:** every reading has to pass a deterministic, microsecond-fast gateway before it's stored.
- **Real phone-test fixes:** the echo, voicing and calibration fixes all came from actual phone logs, not guesses.
- **Accessible design:** 56 pt touch targets, 21 pt patient text, AA contrast in light *and* dark mode, and a UI that respects Reduce Motion.

## What we learned
- **Pick the API by what it can output.** The Live API looks perfect until you notice it can't answer with an image.
- **Let the model point and let code draw.** Asking an LLM for coordinates and rendering them yourself is faster, cheaper and more trustworthy than generating an image.
- **Audio on iOS is its own field of study.** Session categories, output routes and stream lifetimes don't care about your demo schedule.
- **Voice detection needs voicing, not just volume.** Real kitchens are loud.
- **Measure echo only when the echo exists.**
- **Contract tests made restyling safe.** Every `testID` and handler is checked, so we could rework the whole UI without breaking a single button.

## What's next for Gem
- **Speed:** upload each frame to the Gemini Files API once instead of on every question, keep a sparser long-term memory, and start the voice as soon as the answer exists. Waiting time is still Gem's biggest weakness.
- **Smoother interruptions,** possibly with platform echo cancellation in a custom build.
- **Gem as a tool-user:** read a device value, then submit it through the validation gateway in the same conversation ("I read 128 over 82, shall I send that to your study team?").
- **Per-patient study assignment,** multiple languages, and a coordinator dashboard showing which steps patients struggle with.
- **Battery and data savers:** adaptive frame rate when the scene is still.

## Built with
`python` · `fastapi` · `pydantic` · `sqlite` · `httpx` · `pillow` · `google-gemini` · `gemini-api` · `gemini-files-api` · `elevenlabs` · `expo` · `expo-go` · `react-native` · `react` · `typescript` · `react-native-reanimated` · `react-native-gesture-handler` · `expo-camera` · `expo-audio` · `expo-sensors` · `expo-blur` · `pytest` · `jest` · `react-native-testing-library` · `playwright` · `wireguard`

## Did you implement a generative AI model or API in your hack this weekend?
**Yes.**
- **Google Gemini** (`gemini-3.8-flash`, via the `google-genai` SDK): in one structured `generateContent` call per question it does transcription, multi-frame visual reasoning, study-document grounding (Files API) and bounding-box output.
- **ElevenLabs** (`eleven_flash_v2_5`): generates Gem's voice for every answer.
- The legacy capture flow uses `gemini-3.6-flash` to read device displays, and every reading it produces passes the deterministic gateway before storage.
