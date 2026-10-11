# UI Contract — for the styling agent

You may restyle **anything visual**. You may not change behavior. Behavior lives in
hooks; screens only call a hook and render what it returns. Current screenshots:
[`screenshots/`](screenshots/).

## Platform constraints (read first)

- **React Native only.** No DOM elements (`div`, `span`, `button`), no CSS/SCSS files, no
  `className`, no Tailwind-for-web. Use `View`, `Text`, `Pressable`, `Image`, `ScrollView`,
  `TextInput`, `Switch` and `StyleSheet`/style objects.
- **Must run in Expo Go, SDK 57.** Do not add packages with native code unless they are in
  the Expo SDK (install with `npx expo install <pkg>`). Safe choices: `expo-linear-gradient`,
  `expo-blur`, `expo-image`, `@expo/vector-icons`, `expo-font`, `react-native-svg`,
  `react-native-reanimated` (bundled in Expo Go). No `expo-av` (removed; audio is `expo-audio`).
- One codebase: the portal is the **web** build, the Gem assistant is the **native** build.
  Both must keep working (`npx expo start`, then `w` for web; Expo Go for native).
  On web you can preview the Gem assistant at `http://localhost:8081/?patient`.
- Live microphone streaming (`expo-audio` AudioStream) is **native only**; the web preview
  (`?patient`) shows the mic error; questions can only be asked on the phone.

## Where to restyle

1. `mobile/src/ui/theme.ts` — colors (a `light` and a `dark` palette), spacing, radii, font sizes, touch target size.
   Light/dark follows the system appearance (`app.json` `userInterfaceStyle: automatic`).
   Read colors with `const { color } = useTheme()` inside components, never at module scope
   (a `StyleSheet.create` color would be stuck in one mode). Every text token must stay
   WCAG AA in both palettes; `src/__tests__/theme.test.tsx` checks it.
   Camera chrome (status capsule, glass, scrim) is dark in both modes.
2. `mobile/src/ui/primitives.tsx` — `Screen`, `AppText`, `Button`, `Card`, `Glass`, `Pill`, `SectionHeader`, `TextField`, `Toggle`, `Row`, `Spinner`.
   `mobile/src/ui/motion.ts` — curves, durations, springs (use these; don't invent values).
3. Screen layout: `src/screens/assistant/AssistantScreen.tsx` (+ `StatusCapsule.tsx`, `AnswerSheet.tsx`), `src/screens/assistant/PermissionScreen.tsx`,
   `src/screens/portal/PortalScreen.tsx`.

Primitives must keep forwarding `testID`, `onPress`/`onChangeText`/`onChange`, `disabled`,
`loading` and the accessibility props.

## Must not change

- Hook files and their return types: `src/hooks/*`, plus `src/api/*`, `src/logic/*`,
  `src/services/*`, `src/config.ts`, `App.tsx` routing (`selectExperience`).
- Which hook each screen calls, and which hook value/handler each element uses.
- Every `testID` listed below, on an element that renders in the listed state.
- The set of states each screen renders (you may change how each looks).
- `AssistantScreen`'s `CameraView` must keep `ref={attachCamera}` and `onCameraReady={onCameraReady}`.
- `GemRoot` must keep gating `AssistantScreen` behind `permissions.status === 'granted'`.

## Accessibility (older, non-technical patients)

- Touch targets ≥ 56 px tall (`theme.touch.minHeight`); patient body text ≥ 20 px, read-back
  numbers ≥ 30 px. Contrast WCAG AA (4.5:1) minimum; never convey state by color alone
  (keep the words "Saved", "Flagged", "Try again").
- Keep `accessibilityRole="button"`, `accessibilityLabel`, `accessibilityLiveRegion="polite"`
  on the status area. The box overlay stays hidden from screen readers.
- One primary action per state. No gestures that require precision (no swipes, long-press).
  Drag-to-dismiss on the answer sheet is an optional shortcut; the Dismiss button stays.
- Don't show diagnostics to patients (frame counts, change scores, mic on/off).
- Audio is the main channel; on-screen text must match what is spoken
  (`assistant-answer-text` shows `answer.answer` verbatim).

---

## Permissions — `PermissionScreen` (native)

Rendered by `GemRoot` until `usePermissions().status === 'granted'`. Receives the
`PermissionsController` as the `permissions` prop.

| `status` | Required testIDs | Actions |
|----------|------------------|---------|
| `checking` | `permission-checking` | — |
| `needed` | `permission-screen`, `permission-camera-status`, `permission-mic-status`, `permission-grant` | `request` |
| `blocked` | `permission-screen`, `permission-camera-status`, `permission-mic-status`, `permission-blocked`, `permission-open-settings` | `openSettings` |

Copy must say that **both** camera and microphone are required, and show each one's status.

## Assistant — `AssistantScreen` (native; web preview at `?patient`)

Hook: `useAssistant()` →
`{state, attachCamera, onCameraReady, micActive, micError, frames, activity, dismiss, replay, retry}`.
Destructure it (the React Compiler lint flags member access on an object that carries a ref).

No caption of the question while thinking: the transcript of the new question only arrives with the answer, so it would show the previous one.

Always present: `assistant-screen` (root), `assistant-camera` (full-screen `CameraView` with
`ref={attachCamera}`, `onCameraReady={onCameraReady}`, `facing="back"`), `assistant-status`.
There is no typed-question input (removed on request). `frames` and `micActive` are not
rendered (diagnostics).

| Condition | Required testIDs | Data | Actions |
|-----------|------------------|------|---------|
| `state.phase` | `assistant-status` text (`statusLabel`): starting → "Starting…", listening → "Listening", hearing → "Hearing you", thinking → "Thinking", error → "Not connected"; "Speaking" whenever `state.speaking`; "Paused" while `activity !== 'active'` | | |
| `micError` | `assistant-mic-error` | "Gem can't hear you" + `micError` verbatim | |
| `state.notice` | `assistant-notice` | e.g. "I didn't catch that." | |
| listening, active, no question asked yet | `assistant-hint` | "Point at something and ask a question." | |
| `phase === 'thinking'` | `assistant-thinking` | progress indicator | |
| `activity !== 'active'` (and no answer shown) | `assistant-idle` | "Paused" (idle, 1 min) / "Gem is asleep" (expired, 10 min) + "Move your phone or speak to wake Gem" | none — movement or speech wakes it |
| `phase === 'error'` | `assistant-error`, `assistant-retry` | `state.error` | `retry` |
| `state.answer` older frame | `assistant-answer-age` (only when `frameAgeLabel(answer.frameAgeS)` is non-null) | "Seen 58 seconds ago" — the photo is NOT the current view. Shown **under** the photo (with "You asked"), never on it: a portrait photo is narrow and clipped it | |
| `state.answer` | `assistant-answer` (answer sheet), `assistant-answer-listening` (`listeningHint(phase, speaking)`: "Gem is speaking — ask your next question when it finishes." / "Listening — ask a follow-up anytime." / "Hearing you…" / "Thinking…" by `state.phase`), `assistant-answer-image` (only if `imageUri`), `assistant-answer-box` (scrollable text box), `assistant-answer-text`, `assistant-replay`, `assistant-dismiss` | `answer.imageUri` (show with `resizeMode="contain"` — the drawing is baked into the image), `answer.answer` | `replay`, `dismiss` |

Constraints specific to this screen:
- The camera must stay mounted under the answer overlay. Frames are paused while the overlay
  is up (the hook handles it) and resume after Dismiss.
- The mic is ignored while Gem speaks and live again afterwards; keep the listening hint
  visible on the answer sheet so the user knows when to talk.
- `CameraView` must keep `pictureSize={pictureSize}` from the hook (smooth preview).
- Don't play other sounds: the mic is open; Gem's own voice is handled by the hook.
- The answer image already contains the markings; don't draw boxes in the UI.

## Researcher portal — `PortalScreen` (web, desktop width)

Hook: `usePortal()` → see `PortalController` in `src/hooks/usePortal.ts`.

| Area | Required testIDs | Data | Actions |
|------|------------------|------|---------|
| Header | `portal-screen`, `portal-connection` | `connected`, `health.ai_mode`, `health.gemini_model`, `health.voice_enabled` | — |
| Gem inactivity | `portal-settings`, `portal-idle-minutes`, `portal-purge-minutes`, `portal-settings-save`, `portal-settings-message` (when set), `portal-settings-error` (when set) | `idleMinutes`, `purgeMinutes`, `settingsSaving`, `settingsMessage`, `settingsError` | `setIdleMinutes`, `setPurgeMinutes`, `saveSettings` (`loading` = `settingsSaving`) |
| Editor | `portal-editor`, `portal-load-bp-preset`, `portal-title-input`, `portal-prompt-input`, `portal-add-metric`, `portal-cross-field`, `portal-deploy` | `draft` | `loadBloodPressurePreset`, `setTitle`, `setPromptText`, `addMetric`, `setSystolicAboveDiastolic`, `deploy` (`loading` = `deploying`) |
| Metric row *i* | `portal-metric-{i}`, `portal-metric-{i}-name`, `-label`, `-unit`, `-hard_min`, `-min`, `-max`, `-hard_max`, `-required`, `-remove` | `draft.rules.metrics[i]` | `updateMetric(i, field, value)`, `removeMetric(i)` |
| Form feedback | `portal-form-errors` (when `formErrors.length`), `portal-deploy-message` (when set) | | |
| Protocols | `portal-protocols`, `portal-protocol-{id}`, `portal-activate-{id}` / `portal-deactivate-{id}`, `portal-protocols-empty` | `protocols` | `activate(id)`, `deactivate(id)` |
| Study documents (always the active protocol's; shown under Protocols) | `portal-documents`, `portal-documents-protocol`, `portal-document-{doc_id}`, `portal-document-delete-{doc_id}`, `portal-documents-empty`, `portal-note-title`, `portal-note-text`, `portal-note-add`, `portal-upload-file`, `portal-documents-error`, `portal-documents-no-protocol` | `documentsProtocol`, `documents[]` (kind, title, size, `uploaded_to_gemini`), `noteTitle`, `noteText`, `documentsBusy`, `documentsError` | `setNoteTitle`, `setNoteText`, `addNote`, `uploadFile` (opens the file picker), `deleteDocument(id)` |
| Gateway | `portal-gateway-metrics`, `portal-latency` | `metrics.validation.{p50_us,p95_us,p99_us,count}`, `metrics.events_stored`, `rejections.length` | — |
| Readings | `portal-events`, `portal-event-{event_id}`, `portal-events-empty` | `events[]` (status, readings, time, patient, `validation_ns`) | — |
| Blocked | `portal-rejections`, `portal-rejection-{rejection_id}`, `portal-rejections-empty` | `rejections[]` (errors, readings, time) | — |

Label the limit fields in plain language: "Reject below/above" = `hard_min`/`hard_max`
(treated as AI misreads, never stored), "Flag below/above" = `min`/`max` (stored and flagged).

## Verifying a restyle

```bash
cd mobile
npm run typecheck && npm run lint && npm test
```
`src/__tests__/AssistantScreen.contract.test.tsx` and `PortalScreen.contract.test.tsx` render
every state above with mocked hooks and check the testIDs and handlers. A failure names
exactly what to reconnect. Then run the HUMAN_TESTS "UI smoke" section on a phone.

Screenshots (web preview with a fake camera): `screenshots/gem-listening.png` (web shows the
mic error card), `screenshots/gem-paused.png`, `screenshots/gem-answer.png`,
`screenshots/gem-answer-earlier.png`, `screenshots/portal.png`; dark mode:
`screenshots/gem-answer-dark.png`, `screenshots/portal-dark.png`; README crops: `screenshots/portal-top.png`, `screenshots/portal-top-dark.png`.
