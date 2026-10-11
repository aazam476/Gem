/**
 * Patient app (native). Rendering only: all behavior comes from the hooks.
 * Contract: docs/UI_CONTRACT.md §Patient.
 */
import { useState } from 'react';
import { Image, StyleSheet, View, type LayoutChangeEvent } from 'react-native';

import { useActiveProtocol } from '../../hooks/useActiveProtocol';
import { useCameraAccess } from '../../hooks/useCameraAccess';
import { useCapture } from '../../hooks/useCapture';
import { summarizeReadings } from '../../logic/format';
import { AppText, Button, Card, Screen, Spinner } from '../../ui/primitives';
import { theme } from '../../ui/theme';
import { BoundingBoxOverlay } from './BoundingBoxOverlay';
import { CameraPreview } from './CameraPreview';

export function PatientScreen() {
  const protocolState = useActiveProtocol();
  const camera = useCameraAccess();
  const capture = useCapture(protocolState.protocol, protocolState.refresh);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });

  if (protocolState.status === 'loading') {
    return (
      <Screen testID="patient-loading">
        <AppText variant="patient">Getting your study step…</AppText>
      </Screen>
    );
  }
  if (protocolState.status !== 'ready' || !protocolState.protocol) {
    const offline = protocolState.status === 'offline';
    return (
      <Screen testID={offline ? 'patient-offline' : 'patient-no-protocol'}>
        <AppText variant="title">{offline ? "Can't reach the study" : 'Nothing to do yet'}</AppText>
        <AppText variant="patient" tone="muted">
          {offline
            ? 'Check your Wi-Fi, then try again.'
            : 'Your study team has not sent a task yet. Please check back later.'}
        </AppText>
        <Button testID="patient-retry-protocol" label="Try again" onPress={protocolState.refresh} />
      </Screen>
    );
  }
  if (camera.granted !== true) {
    return (
      <Screen testID="patient-permission">
        <AppText variant="title">Camera needed</AppText>
        <AppText variant="patient" tone="muted">
          {"I use the camera to read your device's screen. Photos are only used for this study step."}
        </AppText>
        {camera.granted === false && !camera.canAskAgain ? (
          <AppText variant="patient" tone="danger">
            {"Please allow camera access in your phone's Settings."}
          </AppText>
        ) : (
          <Button testID="patient-grant-camera" label="Allow camera" onPress={camera.request} />
        )}
      </Screen>
    );
  }

  const { state } = capture;
  const photo = 'photo' in state ? state.photo : null;
  const result = state.kind === 'confirm' || state.kind === 'saving' || state.kind === 'rejected' || state.kind === 'unclear'
    ? state.capture
    : null;
  const imageSize = result
    ? { width: result.image_width, height: result.image_height }
    : photo
      ? { width: photo.width, height: photo.height }
      : null;
  const rules = protocolState.protocol.validation_rules.metrics;

  return (
    <Screen testID="patient-screen" padded={false}>
      <View style={{ padding: theme.space.md }}>
        <AppText variant="small" tone="muted" testID="patient-protocol-title">
          {protocolState.protocol.title}
        </AppText>
        <AppText variant="patient" testID="patient-instructions">
          {protocolState.protocol.prompt_text}
        </AppText>
      </View>

      <View
        testID="patient-viewport"
        style={{ flex: 1, backgroundColor: '#000', overflow: 'hidden' }}
        onLayout={(e: LayoutChangeEvent) => setViewport(e.nativeEvent.layout)}
      >
        <CameraPreview attachCamera={capture.attachCamera} onReady={capture.onCameraReady} />
        {photo && state.kind !== 'idle' ? (
          <Image testID="patient-photo" source={{ uri: photo.uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : null}
        {result && imageSize ? <BoundingBoxOverlay box={result.bounding_box} image={imageSize} view={viewport} /> : null}
        {state.kind === 'analyzing' || state.kind === 'saving' ? (
          <View
            testID="patient-busy-overlay"
            accessibilityLiveRegion="polite"
            style={[StyleSheet.absoluteFill, { backgroundColor: theme.color.overlay, alignItems: 'center', justifyContent: 'center', padding: theme.space.lg }]}
          >
            <Spinner />
            <AppText variant="patient" tone="inverse">
              {state.kind === 'saving' ? 'Saving…' : 'Looking at the screen…'}
            </AppText>
            {state.kind === 'analyzing' && state.slow ? (
              <AppText testID="patient-slow-notice" variant="body" tone="inverse">
                This is taking a little longer than usual. Please hold on.
              </AppText>
            ) : null}
          </View>
        ) : null}
      </View>

      <View style={{ padding: theme.space.md }} accessibilityLiveRegion="polite">
        {state.kind === 'idle' ? (
          <Button
            testID="patient-analyze"
            label="Read my device"
            onPress={capture.analyze}
            disabled={!capture.cameraReady || capture.busy}
            accessibilityHint="Takes a photo of your device screen"
          />
        ) : null}

        {state.kind === 'analyzing' ? (
          <Button testID="patient-analyze" label="Read my device" onPress={capture.analyze} disabled />
        ) : null}

        {state.kind === 'confirm' || state.kind === 'saving' ? (
          <Card testID="patient-confirm">
            <AppText variant="hero" testID="patient-readings">
              {summarizeReadings(state.capture.readings, rules)}
            </AppText>
            <AppText variant="patient" testID="patient-voice-text">
              {state.capture.voice_script}
            </AppText>
            {state.capture.flags.length > 0 ? (
              <AppText variant="body" tone="warning" testID="patient-flag-notice">
                {"This is outside your usual range. If it's right, I'll save it and let your study team know."}
              </AppText>
            ) : null}
            {state.kind === 'confirm' && state.error ? (
              <AppText variant="body" tone="danger" testID="patient-confirm-error">
                {state.error}
              </AppText>
            ) : null}
            <Button
              testID="patient-confirm-yes"
              label="Yes, that's right"
              onPress={capture.confirm}
              loading={state.kind === 'saving'}
            />
            <Button
              testID="patient-confirm-no"
              label="No, try again"
              variant="secondary"
              onPress={capture.retake}
              disabled={state.kind === 'saving'}
            />
          </Card>
        ) : null}

        {state.kind === 'saved' ? (
          <Card testID="patient-saved">
            <AppText variant="title" tone="success">
              {state.duplicate ? 'Already saved' : 'Saved'}
            </AppText>
            <AppText variant="patient" testID="patient-saved-readings">
              {summarizeReadings(state.event.extracted_data, rules)}
            </AppText>
            <AppText variant="patient" testID="patient-voice-text">
              {state.message}
            </AppText>
            {state.flagged ? (
              <AppText variant="body" tone="warning" testID="patient-flag-notice">
                Your study team will review this reading.
              </AppText>
            ) : null}
            <Button testID="patient-done" label="Done" onPress={capture.retake} />
          </Card>
        ) : null}

        {state.kind === 'unclear' || state.kind === 'rejected' || state.kind === 'offline' || state.kind === 'error' ? (
          <Card testID={`patient-${state.kind}`}>
            <AppText variant="patient" tone={state.kind === 'rejected' ? 'warning' : 'default'} testID="patient-voice-text">
              {state.message}
            </AppText>
            <Button testID="patient-try-again" label="Try again" onPress={capture.retake} />
          </Card>
        ) : null}

        {state.kind !== 'idle' && state.kind !== 'analyzing' && state.kind !== 'saving' ? (
          <Button testID="patient-repeat-voice" label="Say that again" variant="secondary" onPress={capture.repeatVoice} />
        ) : null}
      </View>
    </Screen>
  );
}
