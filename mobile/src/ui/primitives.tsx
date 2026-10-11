/**
 * Shared building blocks. Screens use only these (plus layout Views), so restyling
 * them restyles the app. Every interactive primitive forwards `testID`.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { BlurView } from 'expo-blur';
import { useState, type ComponentProps, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import Animated from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CSS_EASE_OUT, DURATION } from './motion';
import { theme } from './theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];

type Tone = 'default' | 'muted' | 'success' | 'warning' | 'danger' | 'inverse' | 'inverseMuted' | 'primary';

const toneColor: Record<Tone, string> = {
  default: theme.color.text,
  muted: theme.color.textMuted,
  success: theme.color.success,
  warning: theme.color.warning,
  danger: theme.color.danger,
  inverse: theme.color.onCamera,
  inverseMuted: theme.color.onCameraMuted,
  primary: theme.color.primary,
};

type Variant = 'body' | 'patient' | 'title' | 'hero' | 'small';
const weightFor: Record<Variant, TextStyle['fontWeight']> = {
  small: '400',
  body: '400',
  patient: '400',
  title: '700',
  hero: '700',
};

export function AppText(props: {
  children: ReactNode;
  variant?: Variant;
  tone?: Tone;
  weight?: TextStyle['fontWeight'];
  align?: TextStyle['textAlign'];
  numberOfLines?: number;
  testID?: string;
  style?: StyleProp<TextStyle>;
}) {
  const variant = props.variant ?? 'body';
  const [size, lineHeight, letterSpacing] = theme.type[variant];
  return (
    <Text
      testID={props.testID}
      numberOfLines={props.numberOfLines}
      style={[
        {
          fontSize: size,
          lineHeight,
          letterSpacing,
          color: toneColor[props.tone ?? 'default'],
          fontWeight: props.weight ?? weightFor[variant],
          textAlign: props.align,
        },
        props.style,
      ]}
    >
      {props.children}
    </Text>
  );
}

const buttonColors = {
  primary: { bg: theme.color.primary, fg: theme.color.onPrimary },
  secondary: { bg: theme.color.secondary, fg: theme.color.onSecondary },
  danger: { bg: theme.color.dangerSoft, fg: theme.color.danger },
  glass: { bg: 'rgba(255, 255, 255, 0.18)', fg: theme.color.onCamera },
  light: { bg: theme.color.onCamera, fg: theme.color.text },
  plain: { bg: 'transparent', fg: theme.color.primary },
} as const;

/**
 * Press feedback: scale 0.97 on press-in in 120 ms, a Reanimated CSS transition
 * (animate-expo: tens of times a day -> near-imperceptible; purpose: feedback).
 */
export function Button(props: {
  label: string;
  onPress: () => void;
  testID: string;
  variant?: keyof typeof buttonColors;
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
  compact?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const [pressed, setPressed] = useState(false);
  const colors = buttonColors[props.variant ?? 'primary'];
  const disabled = props.disabled || props.loading;
  return (
    <Pressable
      testID={props.testID}
      onPress={props.onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      disabled={disabled}
      hitSlop={8}
      pressRetentionOffset={16}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ disabled: !!disabled, busy: !!props.loading }}
      style={props.style}
    >
      <Animated.View
        style={{
          ...StyleSheet.flatten([
            styles.button,
            props.compact && styles.buttonCompact,
            { backgroundColor: colors.bg, opacity: disabled ? 0.45 : 1 },
            pressed && !disabled ? styles.pressed : styles.unpressed,
          ]),
          ...PRESS_TRANSITION,
        }}
      >
        {props.loading ? (
          <ActivityIndicator color={colors.fg} />
        ) : (
          <>
            {props.icon ? <Ionicons name={props.icon} size={props.compact ? 18 : 22} color={colors.fg} /> : null}
            <Text
              numberOfLines={1}
              style={{ color: colors.fg, fontSize: props.compact ? 15 : 18, fontWeight: '600', letterSpacing: -0.2 }}
            >
              {props.label}
            </Text>
          </>
        )}
      </Animated.View>
    </Pressable>
  );
}

/** Reanimated CSS transition: the scale follows `pressed` on the UI thread. */
const PRESS_TRANSITION = {
  transitionProperty: 'transform',
  transitionDuration: DURATION.press,
  transitionTimingFunction: CSS_EASE_OUT,
} as const;

export function Card(props: { children: ReactNode; testID?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View testID={props.testID} style={[styles.card, props.style]}>
      {props.children}
    </View>
  );
}

/**
 * Translucent dark material for chrome floating over the camera (apple-design §12:
 * functional layer that doesn't steal focus). Android gets a solid translucent fill
 * (no live blur, which is expensive there).
 */
export function Glass(props: { children: ReactNode; testID?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View testID={props.testID} style={[styles.glass, props.style]}>
      {Platform.OS === 'ios' ? <BlurView tint="dark" intensity={45} style={StyleSheet.absoluteFill} /> : null}
      {props.children}
    </View>
  );
}

export function Pill(props: {
  label: string;
  tone?: 'success' | 'warning' | 'danger' | 'neutral';
  icon?: IconName;
  testID?: string;
}) {
  const palette = {
    success: [theme.color.successSoft, theme.color.success],
    warning: [theme.color.warningSoft, theme.color.warning],
    danger: [theme.color.dangerSoft, theme.color.danger],
    neutral: [theme.color.secondary, theme.color.textMuted],
  }[props.tone ?? 'neutral'];
  return (
    <View testID={props.testID} style={[styles.pill, { backgroundColor: palette[0] }]}>
      {props.icon ? <Ionicons name={props.icon} size={14} color={palette[1]} /> : null}
      <Text style={{ color: palette[1], fontSize: 13, fontWeight: '600' }}>{props.label}</Text>
    </View>
  );
}

export function SectionHeader(props: { title: string; subtitle?: string; testID?: string }) {
  return (
    <View testID={props.testID} style={{ marginTop: theme.space.lg, marginBottom: theme.space.sm, gap: 2 }}>
      <AppText variant="title">{props.title}</AppText>
      {props.subtitle ? (
        <AppText variant="small" tone="muted">
          {props.subtitle}
        </AppText>
      ) : null}
    </View>
  );
}

export function Screen(props: {
  children: ReactNode;
  scroll?: boolean;
  testID?: string;
  padded?: boolean;
  background?: string;
}) {
  const padding = props.padded === false ? 0 : theme.space.md;
  const bg = props.background ?? theme.color.background;
  return (
    <SafeAreaView testID={props.testID} style={{ flex: 1, backgroundColor: bg }}>
      {props.scroll ? (
        <ScrollView contentContainerStyle={{ padding, paddingBottom: theme.space.xxl }}>{props.children}</ScrollView>
      ) : (
        <View style={{ flex: 1, padding }}>{props.children}</View>
      )}
    </SafeAreaView>
  );
}

export function TextField(props: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  testID: string;
  multiline?: boolean;
  numeric?: boolean;
  placeholder?: string;
  width?: number;
  suffix?: string;
}) {
  return (
    <View style={{ marginVertical: theme.space.xs, width: props.width, gap: 6 }}>
      <AppText variant="small" tone="muted" weight="500">
        {props.label}
      </AppText>
      <View style={styles.fieldRow}>
        <TextInput
          testID={props.testID}
          accessibilityLabel={props.label}
          value={props.value}
          onChangeText={props.onChangeText}
          multiline={props.multiline}
          placeholder={props.placeholder}
          placeholderTextColor={theme.color.textMuted}
          keyboardType={props.numeric ? 'decimal-pad' : 'default'}
          style={[styles.field, props.multiline && { minHeight: 96, textAlignVertical: 'top' }]}
        />
        {props.suffix ? (
          <AppText variant="small" tone="muted" style={{ marginLeft: theme.space.sm }}>
            {props.suffix}
          </AppText>
        ) : null}
      </View>
    </View>
  );
}

export function Toggle(props: { label: string; value: boolean; onChange: (v: boolean) => void; testID: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.sm, marginVertical: theme.space.xs }}>
      <Switch
        testID={props.testID}
        accessibilityLabel={props.label}
        value={props.value}
        onValueChange={props.onChange}
        trackColor={{ true: theme.color.success, false: theme.color.secondary }}
      />
      <AppText variant="small">{props.label}</AppText>
    </View>
  );
}

export function Row(props: { children: ReactNode; style?: StyleProp<ViewStyle>; testID?: string }) {
  return (
    <View
      testID={props.testID}
      style={[{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm, alignItems: 'center' }, props.style]}
    >
      {props.children}
    </View>
  );
}

export function Spinner(props: { testID?: string; color?: string }) {
  return <ActivityIndicator testID={props.testID} size="large" color={props.color ?? theme.color.onCamera} />;
}

export { Ionicons };

const styles = StyleSheet.create({
  button: {
    minHeight: theme.touch.minHeight,
    paddingHorizontal: theme.space.lg,
    borderRadius: theme.radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.sm,
  },
  buttonCompact: { minHeight: 44, paddingHorizontal: theme.space.md, borderRadius: theme.radius.sm },
  unpressed: { transform: [{ scale: 1 }] },
  pressed: { transform: [{ scale: 0.97 }] },
  card: {
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    padding: theme.space.lg,
    marginVertical: theme.space.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.separator,
  },
  glass: {
    overflow: 'hidden',
    borderRadius: theme.radius.lg,
    backgroundColor: Platform.OS === 'ios' ? 'rgba(20, 20, 24, 0.35)' : theme.color.glassFallback,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.glassBorder,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: theme.radius.pill,
    alignSelf: 'flex-start',
  },
  fieldRow: { flexDirection: 'row', alignItems: 'center' },
  field: {
    flex: 1,
    minWidth: 0,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: theme.font.body,
    minHeight: 44,
    backgroundColor: theme.color.surface,
    color: theme.color.text,
  },
});
