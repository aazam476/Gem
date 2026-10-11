/**
 * Gem's answer: the marked-up photo, the spoken text and two actions, on a sheet that
 * rises over the camera (the camera stays mounted underneath; frames pause meanwhile).
 *
 * Motion (animate-expo): occasional -> standard animation; purpose: spatial consistency
 * (the answer comes up from the bottom and leaves the same way). Spring entry
 * {300 ms, damping 0.8}, 200 ms exit. Dragging the photo down dismisses it, with
 * rubber-banding upward and a velocity-projected decision; the Dismiss button stays
 * the primary way out (no precision gestures required). Reduced motion: crossfade only.
 */
import { Image, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  FadeIn,
  FadeOut,
  interpolate,
  SlideInDown,
  SlideOutDown,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import { frameAgeLabel, type AssistantAnswer, type AssistantPhase } from '../../logic/assistantState';
import { DURATION, EASE_OUT, project, rubberband, SHEET_SPRING } from '../../ui/motion';
import { AppText, Button, Glass, Ionicons, Row } from '../../ui/primitives';
import { theme } from '../../ui/theme';

// Layout animation builders live at module scope (built once, not per render).
const SHEET_IN = SlideInDown.springify(SHEET_SPRING.duration).dampingRatio(SHEET_SPRING.dampingRatio);
const SHEET_OUT = SlideOutDown.duration(DURATION.exit).easing(EASE_OUT);
const FADE_IN = FadeIn.duration(DURATION.enter).easing(EASE_OUT);
const FADE_OUT = FadeOut.duration(DURATION.exit).easing(EASE_OUT);

/** Dismiss when the drag (plus where the flick would carry it) passes this share of the screen. */
const DISMISS_FRACTION = 0.25;

export function listeningHint(phase: AssistantPhase): string {
  if (phase === 'hearing') return 'Hearing you…';
  if (phase === 'thinking') return 'Thinking…';
  return 'Still listening — ask a follow-up anytime.';
}

export function AnswerSheet(props: {
  answer: AssistantAnswer;
  phase: AssistantPhase;
  speaking: boolean;
  onReplay: () => void;
  onDismiss: () => void;
}) {
  const { answer, phase, speaking, onReplay, onDismiss } = props;
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const drag = useSharedValue(0);
  const age = frameAgeLabel(answer.frameAgeS);

  const pan = Gesture.Pan()
    .activeOffsetY([-8, 8])
    .onUpdate((e) => {
      const y = e.translationY;
      drag.set(y >= 0 ? y : -rubberband(-y, height));
    })
    .onEnd((e) => {
      const projected = drag.get() + project(e.velocityY);
      if (projected > height * DISMISS_FRACTION) {
        drag.set(
          withSpring(height, { ...SHEET_SPRING, velocity: e.velocityY }, (finished) => {
            if (finished) scheduleOnRN(onDismiss);
          }),
        );
      } else {
        drag.set(withSpring(0, { ...SHEET_SPRING, velocity: e.velocityY }));
      }
    });

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: drag.get() }] }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: interpolate(drag.get(), [0, height * 0.6], [1, 0], 'clamp'),
  }));

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View entering={FADE_IN} exiting={FADE_OUT} style={StyleSheet.absoluteFill} pointerEvents="none">
        <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, backdropStyle]} />
      </Animated.View>

      <Animated.View
        testID="assistant-answer"
        entering={reduceMotion ? FADE_IN : SHEET_IN}
        exiting={reduceMotion ? FADE_OUT : SHEET_OUT}
        style={[styles.anchor, { maxHeight: height - insets.top - theme.space.sm }]}
      >
        <Animated.View style={[styles.sheet, { paddingBottom: insets.bottom + theme.space.md }, sheetStyle]}>
          <GestureDetector gesture={pan}>
            <View>
              <View style={styles.grabber} accessible={false} />
              {answer.imageUri ? (
                <View
                  style={[
                    styles.photo,
                    { aspectRatio: answer.imageWidth / Math.max(1, answer.imageHeight), maxHeight: height * 0.45 },
                  ]}
                >
                  <Image
                    testID="assistant-answer-image"
                    source={{ uri: answer.imageUri }}
                    style={StyleSheet.absoluteFill}
                    resizeMode="contain"
                    accessibilityLabel="Your camera view with Gem's markings"
                  />
                  {age ? (
                    <Glass style={styles.ageChip}>
                      <Row style={styles.ageRow}>
                        <Ionicons name="time-outline" size={16} color={theme.color.onCamera} />
                        <AppText variant="small" tone="inverse" weight="600" testID="assistant-answer-age">
                          {age}
                        </AppText>
                      </Row>
                    </Glass>
                  ) : null}
                </View>
              ) : null}
            </View>
          </GestureDetector>

          {answer.transcript ? (
            <AppText variant="small" tone="muted" numberOfLines={2} style={styles.asked}>
              {`You asked: “${answer.transcript}”`}
            </AppText>
          ) : null}

          <Animated.ScrollView
            testID="assistant-answer-box"
            style={styles.textBox}
            contentContainerStyle={styles.textBoxContent}
          >
            <AppText variant="patient" testID="assistant-answer-text">
              {answer.answer}
            </AppText>
          </Animated.ScrollView>

          <Row style={styles.hint}>
            <View style={[styles.hintDot, phase === 'hearing' && styles.hintDotHearing]} />
            <AppText variant="small" tone="muted" testID="assistant-answer-listening" style={{ flex: 1 }}>
              {listeningHint(phase)}
            </AppText>
          </Row>

          <View style={styles.actions}>
            <Button
              testID="assistant-replay"
              label={speaking ? 'Speaking…' : 'Read again'}
              icon="volume-high"
              variant="secondary"
              onPress={onReplay}
              style={{ flex: 1 }}
            />
            <Button testID="assistant-dismiss" label="Dismiss" onPress={onDismiss} style={{ flex: 1 }} />
          </View>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: theme.color.scrim },
  anchor: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  sheet: {
    flexShrink: 1,
    backgroundColor: theme.color.surface,
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
    paddingHorizontal: theme.space.md,
    gap: theme.space.sm,
  },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: theme.color.border,
    marginTop: theme.space.sm,
    marginBottom: theme.space.sm,
  },
  photo: { width: '100%', borderRadius: theme.radius.lg, overflow: 'hidden', backgroundColor: '#000' },
  ageChip: { position: 'absolute', top: theme.space.sm, left: theme.space.sm, borderRadius: theme.radius.pill },
  ageRow: { paddingHorizontal: 12, paddingVertical: 6, gap: 6, flexWrap: 'nowrap' },
  asked: { marginTop: theme.space.xs },
  textBox: { flexGrow: 0, flexShrink: 1, maxHeight: 260 },
  textBoxContent: { paddingVertical: theme.space.xs },
  hint: { gap: theme.space.sm, flexWrap: 'nowrap' },
  hintDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color.listening },
  hintDotHearing: { backgroundColor: theme.color.hearing },
  actions: { flexDirection: 'row', gap: theme.space.sm },
});
