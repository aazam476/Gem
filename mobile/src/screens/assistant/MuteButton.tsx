/**
 * Round glass mute button over the camera (top right). White microphone = Gem listens;
 * red slashed microphone = muted (nothing the user says is heard or sent).
 * Press feedback: scale 0.97 in 120 ms (Reanimated CSS transition); the icon swaps
 * instantly — a state toggle the user fires on purpose needs no extra motion.
 */
import { useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated from 'react-native-reanimated';

import { CSS_EASE_OUT, DURATION } from '../../ui/motion';
import { Glass, Ionicons } from '../../ui/primitives';
import { theme, useTheme } from '../../ui/theme';

const SIZE = 52;

export function MuteButton(props: { muted: boolean; onPress: () => void }) {
  const { color } = useTheme();
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      testID="assistant-mute"
      onPress={props.onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={props.muted ? 'Unmute microphone' : 'Mute microphone'}
      accessibilityHint={props.muted ? 'Gem will listen to you again' : 'Gem stops listening to you'}
      accessibilityState={{ selected: props.muted }}
    >
      <Animated.View
        style={{
          transform: [{ scale: pressed ? 0.97 : 1 }],
          transitionProperty: 'transform',
          transitionDuration: DURATION.press,
          transitionTimingFunction: CSS_EASE_OUT,
        }}
      >
        <Glass style={styles.circle}>
          <Ionicons
            testID={props.muted ? 'assistant-mute-icon-off' : 'assistant-mute-icon-on'}
            name={props.muted ? 'mic-off' : 'mic'}
            size={26}
            color={props.muted ? color.onCameraDanger : color.onCamera}
            style={styles.icon}
          />
        </Glass>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  circle: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: { textAlign: 'center' },
});

export const MUTE_BUTTON_SPACE = SIZE + theme.space.sm * 2;
