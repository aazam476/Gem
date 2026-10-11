# UI Contract — for the styling agent

You may restyle **anything visual**. You may not change behavior. Behavior lives in
hooks; screens only call a hook and render what it returns. Current barebones
screenshots: [`screenshots/`](screenshots/).

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
  (`?patient`) shows the mic error and works with typed questions.

## Where to restyle

1. `mobile/src/ui/theme.ts` — colors, spacing, radii, font sizes, touch target size.
2. `mobile/src/ui/primitives.tsx` — `Screen`, `AppText`, `Button`, `Card`, `TextField`, `Toggle`, `Row`, `Spinner`.
3. Screen layout: `src/screens/assistant/AssistantScreen.tsx`, `src/screens/assistant/PermissionScreen.tsx`,
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
`{state, attachCamera, onCameraReady, micActive, micError, frames, dismiss, replay, retry, sendText}`.
Destructure it (the React Compiler lint flags member access on an object that carries a ref).

Always present: `assistant-screen` (root), `assistant-camera` (full-screen `CameraView` with
`ref={attachCamera}`, `onCameraReady={onCameraReady}`, `facing="back"`), `assistant-status`,
`assistant-mic`, `assistant-frames`, `assistant-text-input`, `assistant-send`.

| Condition | Required testIDs | Data | Actions |
|-----------|------------------|------|---------|
| `state.phase` | `assistant-status` text: starting → "Starting…", listening → "Listening…", hearing → "Hearing you…", thinking → "Thinking…", error → "Connection problem"; "Speaking…" whenever `state.speaking` | | |
| mic | `assistant-mic` | `micActive`, `micError` (shown verbatim; on web it explains to type instead) | |
| frames | `assistant-frames` | `frames.sent`, `frames.remembered`, `frames.lastChangeScore` (diagnostic; may be visually de-emphasized) | |
| `state.lastTranscript` | `assistant-heard` | "You said: …" | |
| `state.notice` | `assistant-notice` | e.g. "I didn't catch that." | |
| `phase === 'thinking'` | `assistant-thinking` | progress indicator | |
| `phase === 'error'` | `assistant-error`, `assistant-retry` | `state.error` | `retry` |
| typed question | `assistant-text-input`, `assistant-send` | | `sendText(text)` then clear; send disabled while empty/thinking/starting |
| `state.answer` older frame | `assistant-answer-age` (only when `frameAgeLabel(answer.frameAgeS)` is non-null) | "Seen 58 seconds ago" — the photo is NOT the current view | |
| `state.answer` | `assistant-answer` (full-screen overlay), `assistant-answer-image` (only if `imageUri`), `assistant-answer-box` (scrollable text box), `assistant-answer-text`, `assistant-replay`, `assistant-dismiss` | `answer.imageUri` (show with `resizeMode="contain"` — the drawing is baked into the image), `answer.answer` | `replay`, `dismiss` |

Constraints specific to this screen:
- The camera must stay mounted under the answer overlay (frames keep flowing).
- Don't play other sounds: the mic is open; Gem's own voice is handled by the hook.
- The answer image already contains the markings; don't draw boxes in the UI.

## Researcher portal — `PortalScreen` (web, desktop width)

Hook: `usePortal()` → see `PortalController` in `src/hooks/usePortal.ts`.

| Area | Required testIDs | Data | Actions |
|------|------------------|------|---------|
| Header | `portal-screen`, `portal-connection` | `connected`, `health.ai_mode`, `health.gemini_model`, `health.voice_enabled` | — |
| Editor | `portal-editor`, `portal-load-bp-preset`, `portal-title-input`, `portal-prompt-input`, `portal-add-metric`, `portal-cross-field`, `portal-deploy` | `draft` | `loadBloodPressurePreset`, `setTitle`, `setPromptText`, `addMetric`, `setSystolicAboveDiastolic`, `deploy` (`loading` = `deploying`) |
| Metric row *i* | `portal-metric-{i}`, `portal-metric-{i}-name`, `-label`, `-unit`, `-hard_min`, `-min`, `-max`, `-hard_max`, `-required`, `-remove` | `draft.rules.metrics[i]` | `updateMetric(i, field, value)`, `removeMetric(i)` |
| Form feedback | `portal-form-errors` (when `formErrors.length`), `portal-deploy-message` (when set) | | |
| Protocols | `portal-protocols`, `portal-protocol-{id}`, `portal-activate-{id}` / `portal-deactivate-{id}`, `portal-protocols-empty` | `protocols` | `activate(id)`, `deactivate(id)` |
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

Screenshots of the current barebones UI: `screenshots/gem-listening.png`,
`screenshots/gem-answer.png` (web preview with a fake camera), `screenshots/portal-*.png`.
