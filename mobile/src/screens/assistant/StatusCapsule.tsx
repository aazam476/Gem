/**
 * The one piece of chrome always on the camera: what Gem is doing right now.
 * State changes crossfade the dot color/scale in 180 ms (state indication; it changes a
 * few times per question, so it stays short and calm). No looping pulse: a constantly
 * moving element over the camera would compete with what the user is looking at.
 */
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import type { AssistantPhase } from '../../logic/assistantState';
import { CSS_EASE_OUT, DURATION } from '../../ui/motion';
import { AppText, Glass, Ionicons, Spinner } from '../../ui/primitives';
import { theme, useTheme } from '../../ui/theme';

const LABEL: Record<AssistantPhase, string> = {
  starting: 'Starting…',
  listening: 'Listening',
  hearing: 'Hearing you',
  thinking: 'Thinking',
  error: 'Not connected',
};

export function statusLabel(phase: AssistantPhase, speaking: boolean, paused: boolean, muted = false): string {
  if (speaking) return 'Speaking';
  if (muted && (phase === 'listening' || phase === 'hearing')) return 'Muted';
  if (paused && (phase === 'listening' || phase === 'hearing')) return 'Paused';
  return LABEL[phase];
}

export function StatusCapsule(props: { phase: AssistantPhase; speaking: boolean; paused: boolean; muted?: boolean }) {
  const { color } = useTheme();
  const { phase, speaking, paused, muted = false } = props;
  const label = statusLabel(phase, speaking, paused, muted);
  const dotColor =
    phase === 'error' || label === 'Muted'
      ? color.onCameraDanger
      : paused
        ? color.onCameraMuted
        : phase === 'hearing'
          ? color.hearing
          : color.listening;
  return (
    <Glass style={styles.capsule}>
      <View accessible accessibilityRole="text" accessibilityLabel={`Gem: ${label}`} accessibilityLiveRegion="polite" style={styles.row}>
        {phase === 'thinking' ? (
          <View testID="assistant-thinking" style={styles.icon}>
            <Spinner />
          </View>
        ) : speaking ? (
          <Ionicons name="volume-high" size={20} color={color.onCamera} style={styles.icon} />
        ) : (
          <Animated.View
            style={{
              ...styles.dot,
              backgroundColor: dotColor,
              transform: [{ scale: phase === 'hearing' ? 1.35 : 1 }],
              transitionProperty: ['transform', 'backgroundColor'],
              transitionDuration: DURATION.state,
              transitionTimingFunction: CSS_EASE_OUT,
            }}
          />
        )}
        <AppText variant="body" tone="inverse" weight="600" testID="assistant-status">
          {label}
        </AppText>
      </View>
    </Glass>
  );
}

const styles = StyleSheet.create({
  capsule: { alignSelf: 'center', borderRadius: theme.radius.pill },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, paddingVertical: 10 },
  dot: { width: 12, height: 12, borderRadius: 6 },
  icon: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center', transform: [{ scale: 0.6 }] },
});
