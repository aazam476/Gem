/**
 * Gem assistant (native). Full-screen camera, always listening. Rendering only: all
 * behavior comes from useAssistant(). Contract: docs/UI_CONTRACT.md §Assistant.
 *
 * The camera is the interface; chrome stays minimal (apple-design: restraint). One
 * status capsule on top; at the bottom, at most one message (error > mic problem >
 * notice > first-run hint). Diagnostics (frames sent, change scores, "mic on") are not
 * shown to patients.
 */
import { CameraView } from 'expo-camera';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, FadeOutDown } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAssistant } from '../../hooks/useAssistant';
import { DURATION, EASE_OUT } from '../../ui/motion';
import { AppText, Button, Glass, Ionicons } from '../../ui/primitives';
import { theme, useTheme } from '../../ui/theme';
import { AnswerSheet } from './AnswerSheet';
import { StatusCapsule } from './StatusCapsule';

// Toast-style messages enter from the bottom and leave the same way (250 / 200 ms).
const MESSAGE_IN = FadeInDown.duration(DURATION.enter).easing(EASE_OUT);
const MESSAGE_OUT = FadeOutDown.duration(DURATION.exit).easing(EASE_OUT);
const FADE_IN = FadeIn.duration(DURATION.enter).easing(EASE_OUT);
const FADE_OUT = FadeOut.duration(DURATION.exit).easing(EASE_OUT);

export function AssistantScreen() {
  const { color } = useTheme();
  const { state, attachCamera, onCameraReady, pictureSize, micError, activity, retry, replay, dismiss } = useAssistant();
  const paused = activity !== 'active';
  const ready = state.phase === 'listening' || state.phase === 'hearing';

  return (
    <View testID="assistant-screen" style={styles.root}>
      {/* Over the camera the status bar is always light, in both modes. */}
      <StatusBar style="light" />
      <CameraView
        testID="assistant-camera"
        ref={attachCamera}
        style={StyleSheet.absoluteFill}
        facing="back"
        animateShutter={false}
        pictureSize={pictureSize}
        onCameraReady={onCameraReady}
      />

      {paused && !state.answer ? (
        <Animated.View testID="assistant-idle" entering={FADE_IN} exiting={FADE_OUT} style={[StyleSheet.absoluteFill, styles.idle, { backgroundColor: color.scrim }]}>
          <Glass style={styles.idleCard}>
            <View style={styles.idleContent}>
              <Ionicons name={activity === 'expired' ? 'moon' : 'pause'} size={34} color={color.onCamera} />
              <AppText variant="title" tone="inverse" align="center">
                {activity === 'expired' ? 'Gem is asleep' : 'Paused'}
              </AppText>
              <AppText variant="patient" tone="inverseMuted" align="center">
                Move your phone or speak to wake Gem.
              </AppText>
            </View>
          </Glass>
        </Animated.View>
      ) : null}

      <SafeAreaView style={styles.chrome} pointerEvents="box-none">
        <View style={styles.top} pointerEvents="box-none">
          <StatusCapsule phase={state.phase} speaking={state.speaking} paused={paused} />
          {state.phase === 'thinking' && state.lastTranscript ? (
            <Animated.View entering={FADE_IN} exiting={FADE_OUT}>
              <Glass style={styles.heard}>
                <AppText variant="body" tone="inverse" align="center" numberOfLines={3} testID="assistant-heard" style={styles.heardText}>
                  {`“${state.lastTranscript}”`}
                </AppText>
              </Glass>
            </Animated.View>
          ) : null}
        </View>

        <View style={styles.bottom} pointerEvents="box-none">
          {state.phase === 'error' ? (
            <Animated.View key="error" entering={MESSAGE_IN} exiting={MESSAGE_OUT}>
              <View testID="assistant-error" style={[styles.card, { backgroundColor: color.surface }]}>
                <View style={styles.cardHeader}>
                  <Ionicons name="cloud-offline" size={24} color={color.danger} />
                  <AppText variant="patient" weight="600" style={{ flex: 1 }}>
                    {state.error}
                  </AppText>
                </View>
                <Button testID="assistant-retry" label="Try again" icon="refresh" onPress={retry} />
              </View>
            </Animated.View>
          ) : micError ? (
            <Animated.View key="mic" entering={MESSAGE_IN} exiting={MESSAGE_OUT}>
              <View testID="assistant-mic-error" style={[styles.card, { backgroundColor: color.surface }]}>
                <View style={styles.cardHeader}>
                  <Ionicons name="mic-off" size={24} color={color.danger} />
                  <View style={{ flex: 1 }}>
                    <AppText variant="patient" weight="600">
                      {"Gem can't hear you"}
                    </AppText>
                    <AppText variant="small" tone="muted">
                      {micError}
                    </AppText>
                  </View>
                </View>
              </View>
            </Animated.View>
          ) : state.notice ? (
            <Animated.View key={`notice-${state.notice}`} entering={MESSAGE_IN} exiting={MESSAGE_OUT}>
              <Glass style={styles.toast}>
                <AppText variant="patient" tone="inverse" align="center" testID="assistant-notice" style={styles.toastText}>
                  {state.notice}
                </AppText>
              </Glass>
            </Animated.View>
          ) : ready && !paused && !state.lastTranscript && !state.answer ? (
            <Animated.View key="hint" entering={MESSAGE_IN} exiting={MESSAGE_OUT}>
              <Glass style={styles.toast}>
                <AppText variant="patient" tone="inverse" align="center" testID="assistant-hint" style={styles.toastText}>
                  Point at something and ask a question.
                </AppText>
              </Glass>
            </Animated.View>
          ) : null}
        </View>
      </SafeAreaView>

      {state.answer ? (
        <AnswerSheet answer={state.answer} phase={state.phase} speaking={state.speaking} onReplay={replay} onDismiss={dismiss} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  chrome: { flex: 1, justifyContent: 'space-between' },
  top: { alignItems: 'center', paddingTop: theme.space.sm, paddingHorizontal: theme.space.md, gap: theme.space.sm },
  heard: { borderRadius: theme.radius.lg, maxWidth: 420 },
  heardText: { paddingHorizontal: theme.space.md, paddingVertical: theme.space.sm },
  bottom: { padding: theme.space.md, gap: theme.space.sm },
  idle: { alignItems: 'center', justifyContent: 'center', padding: theme.space.lg },
  idleCard: { borderRadius: theme.radius.xl, maxWidth: 420, width: '100%' },
  idleContent: { alignItems: 'center', gap: theme.space.sm, padding: theme.space.lg },
  card: {
    borderRadius: theme.radius.lg,
    padding: theme.space.md,
    gap: theme.space.md,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm },
  toast: { alignSelf: 'center', borderRadius: theme.radius.lg, maxWidth: 480 },
  toastText: { paddingHorizontal: theme.space.lg, paddingVertical: theme.space.md },
});
