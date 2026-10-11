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
import { theme, useTheme, type Palette } from './theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];

type Tone = 'default' | 'muted' | 'success' | 'warning' | 'danger' | 'inverse' | 'inverseMuted' | 'primary';

const toneColor = (c: Palette): Record<Tone, string> => ({
  default: c.text,
  muted: c.textMuted,
  success: c.success,
  warning: c.warning,
  danger: c.danger,
  inverse: c.onCamera,
  inverseMuted: c.onCameraMuted,
  primary: c.primaryText,
});

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
  const { color } = useTheme();
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
          color: toneColor(color)[props.tone ?? 'default'],
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

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'glass' | 'light' | 'plain';
const buttonColors = (c: Palette): Record<ButtonVariant, { bg: string; fg: string }> => ({
  primary: { bg: c.primary, fg: c.onPrimary },
  secondary: { bg: c.secondary, fg: c.onSecondary },
  danger: { bg: c.dangerSoft, fg: c.danger },
  glass: { bg: 'rgba(255, 255, 255, 0.18)', fg: c.onCamera },
  light: { bg: c.onCamera, fg: '#111114' },
  plain: { bg: 'transparent', fg: c.primaryText },
});

/**
 * Press feedback: scale 0.97 on press-in in 120 ms, a Reanimated CSS transition
 * (animate-expo: tens of times a day -> near-imperceptible; purpose: feedback).
 */
export function Button(props: {
  label: string;
  onPress: () => void;
  testID: string;
  variant?: ButtonVariant;
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
  compact?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const [pressed, setPressed] = useState(false);
  const { color } = useTheme();
  const colors = buttonColors(color)[props.variant ?? 'primary'];
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
  const { color } = useTheme();
  return (
    <View testID={props.testID} style={[styles.card, { backgroundColor: color.surface, borderColor: color.separator }, props.style]}>
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
  const { color } = useTheme();
  return (
    <View
      testID={props.testID}
      style={[
        styles.glass,
        { backgroundColor: Platform.OS === 'ios' ? color.glassTint : color.glassFallback, borderColor: color.glassBorder },
        props.style,
      ]}
    >
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
  const { color } = useTheme();
  const palette = {
    success: [color.successSoft, color.success],
    warning: [color.warningSoft, color.warning],
    danger: [color.dangerSoft, color.danger],
    neutral: [color.secondary, color.textMuted],
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
  const { color } = useTheme();
  const padding = props.padded === false ? 0 : theme.space.md;
  const bg = props.background ?? color.background;
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
  const { color, scheme } = useTheme();
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
          placeholderTextColor={color.textMuted}
          keyboardType={props.numeric ? 'decimal-pad' : 'default'}
          keyboardAppearance={scheme}
          style={[
            styles.field,
            { borderColor: color.border, backgroundColor: color.surface, color: color.text },
            props.multiline && { minHeight: 96, textAlignVertical: 'top' },
          ]}
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
  const { color } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.sm, marginVertical: theme.space.xs }}>
      <Switch
        testID={props.testID}
        accessibilityLabel={props.label}
        value={props.value}
        onValueChange={props.onChange}
        trackColor={{ true: color.success, false: color.secondary }}
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
  const { color } = useTheme();
  return <ActivityIndicator testID={props.testID} size="large" color={props.color ?? color.onCamera} />;
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
    borderRadius: theme.radius.lg,
    padding: theme.space.lg,
    marginVertical: theme.space.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  glass: {
    overflow: 'hidden',
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
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
    borderRadius: theme.radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: theme.font.body,
    minHeight: 44,
  },
});
