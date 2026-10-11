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
- One codebase: the portal is the **web** build, the patient app is the **native** build.
  Both must keep working (`npx expo start`, then `w` for web; Expo Go for native).
  On web you can preview the patient app at `http://localhost:8081/?patient`.
- The bounding box is drawn over the photo using Gemini's 0–1000 coordinates mapped by
  `src/logic/boxMapping.ts`, which assumes the photo is shown with
  `resizeMode="cover"` and fills `patient-viewport`. If you change how the photo is
  displayed (contain, padding, aspect ratio), update the mapping call accordingly; keep
  `BoundingBoxOverlay` positioned absolutely inside `patient-viewport`.

## Where to restyle

1. `mobile/src/ui/theme.ts` — colors, spacing, radii, font sizes, touch target size.
2. `mobile/src/ui/primitives.tsx` — `Screen`, `AppText`, `Button`, `Card`, `TextField`, `Toggle`, `Row`, `Spinner`.
3. Screen layout: `src/screens/patient/PatientScreen.tsx`, `src/screens/portal/PortalScreen.tsx`,
   `src/screens/patient/BoundingBoxOverlay.tsx`.

Primitives must keep forwarding `testID`, `onPress`/`onChangeText`/`onChange`, `disabled`,
`loading` and the accessibility props.

## Must not change

- Hook files and their return types: `src/hooks/*`, plus `src/api/*`, `src/logic/*`,
  `src/services/*`, `src/config.ts`, `App.tsx` routing (`selectExperience`).
- Which hook each screen calls, and which hook value/handler each element uses.
- Every `testID` listed below, on an element that renders in the listed state.
- The set of states each screen renders (you may change how each looks).
- `CameraPreview` must keep `ref={attachCamera}` and `onCameraReady={onReady}`; the
  analyze button must stay disabled while `!cameraReady || busy`.
- Busy overlay must block touches over the viewport while `analyzing`/`saving`.

## Accessibility (older, non-technical patients)

- Touch targets ≥ 56 px tall (`theme.touch.minHeight`); patient body text ≥ 20 px, read-back
  numbers ≥ 30 px. Contrast WCAG AA (4.5:1) minimum; never convey state by color alone
  (keep the words "Saved", "Flagged", "Try again").
- Keep `accessibilityRole="button"`, `accessibilityLabel`, `accessibilityLiveRegion="polite"`
  on the status area. The box overlay stays hidden from screen readers.
- One primary action per state. No gestures that require precision (no swipes, long-press).
- Audio is the main channel; on-screen text must match what is spoken
  (`patient-voice-text` shows `voice_script`/`message` verbatim).

---

## Patient app — `PatientScreen`

Hooks: `useActiveProtocol()` → `{status, protocol, refresh}`; `useCameraAccess()` →
`{granted, canAskAgain, request}`; `useCapture(protocol, refresh)` →
`{state, busy, attachCamera, cameraReady, onCameraReady, analyze, confirm, retake, repeatVoice}`.

### Pre-capture screens (from `useActiveProtocol` / `useCameraAccess`)

| State | Root testID | Required elements | Actions |
|-------|-------------|-------------------|---------|
| loading protocol | `patient-loading` | text | — |
| no protocol deployed | `patient-no-protocol` | title + explanation | `patient-retry-protocol` → `refresh` |
| backend unreachable | `patient-offline` | title + "check Wi-Fi" | `patient-retry-protocol` → `refresh` |
| camera permission | `patient-permission` | explanation; settings hint if `!canAskAgain` | `patient-grant-camera` → `request` |

### Capture screen (root `patient-screen`)

Always present: `patient-protocol-title` (protocol.title), `patient-instructions`
(protocol.prompt_text), `patient-viewport` (contains `patient-camera`; when a photo exists
and state ≠ idle also `patient-photo`; when the result has a box, `patient-bounding-box`).

| `state.kind` | Required testIDs | Data shown | Actions |
|--------------|------------------|------------|---------|
| `idle` | `patient-analyze` | — | `analyze`; disabled while `!cameraReady \|\| busy` |
| `analyzing` | `patient-busy-overlay`, `patient-analyze` (disabled); `patient-slow-notice` when `state.slow` | photo | none (blocked) |
| `confirm` | `patient-confirm`, `patient-readings`, `patient-voice-text`, `patient-confirm-yes`, `patient-confirm-no`, `patient-repeat-voice`; `patient-flag-notice` if `capture.flags.length`; `patient-confirm-error` if `state.error` | `summarizeReadings(capture.readings)`, `capture.voice_script`, box | yes → `confirm`; no → `retake`; repeat → `repeatVoice` |
| `saving` | same as confirm + `patient-busy-overlay`; yes shows loading | | none (blocked) |
| `saved` | `patient-saved`, `patient-saved-readings`, `patient-voice-text`, `patient-done`, `patient-repeat-voice`; `patient-flag-notice` if `state.flagged` | `event.extracted_data`, `message`, "Already saved" if `duplicate` | done → `retake` |
| `unclear` | `patient-unclear`, `patient-voice-text`, `patient-try-again`, `patient-repeat-voice` | `message`, photo (+box if any) | `retake` |
| `rejected` | `patient-rejected`, `patient-voice-text`, `patient-try-again`, `patient-repeat-voice` | `message` (warning tone), photo + box | `retake` |
| `offline` | `patient-offline`, `patient-voice-text`, `patient-try-again`, `patient-repeat-voice` | `message` | `retake` |
| `error` | `patient-error`, `patient-voice-text`, `patient-try-again`, `patient-repeat-voice` | `message` | `retake` |

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
`src/__tests__/PatientScreen.contract.test.tsx` and `PortalScreen.contract.test.tsx` render
every state above with mocked hooks and check the testIDs and handlers. A failure names
exactly what to reconnect. Then run the HUMAN_TESTS "UI smoke" section on a phone.
