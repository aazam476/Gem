/**
 * Shared building blocks. Screens use only these (plus layout Views), so restyling
 * them restyles the app. Every interactive primitive forwards `testID`.
 */
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from './theme';

type Tone = 'default' | 'muted' | 'success' | 'warning' | 'danger' | 'inverse';

const toneColor: Record<Tone, string> = {
  default: theme.color.text,
  muted: theme.color.textMuted,
  success: theme.color.success,
  warning: theme.color.warning,
  danger: theme.color.danger,
  inverse: theme.color.onPrimary,
};

export function AppText(props: {
  children: ReactNode;
  variant?: 'body' | 'patient' | 'title' | 'hero' | 'small';
  tone?: Tone;
  testID?: string;
  style?: StyleProp<TextStyle>;
}) {
  const size = {
    body: theme.font.body,
    patient: theme.font.patientBody,
    title: theme.font.title,
    hero: theme.font.hero,
    small: theme.font.small,
  }[props.variant ?? 'body'];
  const bold = props.variant === 'title' || props.variant === 'hero';
  return (
    <Text
      testID={props.testID}
      style={[{ fontSize: size, color: toneColor[props.tone ?? 'default'], fontWeight: bold ? '700' : '400' }, props.style]}
    >
      {props.children}
    </Text>
  );
}

export function Button(props: {
  label: string;
  onPress: () => void;
  testID: string;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  loading?: boolean;
  accessibilityHint?: string;
}) {
  const variant = props.variant ?? 'primary';
  const bg = { primary: theme.color.primary, secondary: theme.color.secondary, danger: theme.color.danger }[variant];
  const fg = variant === 'secondary' ? theme.color.onSecondary : theme.color.onPrimary;
  const disabled = props.disabled || props.loading;
  return (
    <Pressable
      testID={props.testID}
      onPress={props.onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ disabled: !!disabled, busy: !!props.loading }}
      style={{
        minHeight: theme.touch.minHeight,
        paddingHorizontal: theme.space.lg,
        borderRadius: theme.radius.md,
        backgroundColor: bg,
        opacity: disabled ? 0.5 : 1,
        alignItems: 'center',
        justifyContent: 'center',
        marginVertical: theme.space.xs,
      }}
    >
      {props.loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={{ color: fg, fontSize: theme.font.body, fontWeight: '700' }}>{props.label}</Text>
      )}
    </Pressable>
  );
}

export function Card(props: { children: ReactNode; testID?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      testID={props.testID}
      style={[
        {
          backgroundColor: theme.color.surface,
          borderRadius: theme.radius.md,
          padding: theme.space.md,
          marginVertical: theme.space.sm,
        },
        props.style,
      ]}
    >
      {props.children}
    </View>
  );
}

export function Screen(props: { children: ReactNode; scroll?: boolean; testID?: string; padded?: boolean }) {
  const padding = props.padded === false ? 0 : theme.space.md;
  return (
    <SafeAreaView testID={props.testID} style={{ flex: 1, backgroundColor: theme.color.background }}>
      {props.scroll ? (
        <ScrollView contentContainerStyle={{ padding }}>{props.children}</ScrollView>
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
}) {
  return (
    <View style={{ marginVertical: theme.space.xs, width: props.width }}>
      <AppText variant="small" tone="muted">
        {props.label}
      </AppText>
      <TextInput
        testID={props.testID}
        accessibilityLabel={props.label}
        value={props.value}
        onChangeText={props.onChangeText}
        multiline={props.multiline}
        placeholder={props.placeholder}
        keyboardType={props.numeric ? 'numeric' : 'default'}
        style={{
          borderWidth: 1,
          borderColor: theme.color.border,
          borderRadius: theme.radius.sm,
          padding: theme.space.sm,
          fontSize: theme.font.body,
          minHeight: props.multiline ? 88 : 44,
          backgroundColor: theme.color.background,
          color: theme.color.text,
        }}
      />
    </View>
  );
}

export function Toggle(props: { label: string; value: boolean; onChange: (v: boolean) => void; testID: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.sm, marginVertical: theme.space.xs }}>
      <Switch testID={props.testID} accessibilityLabel={props.label} value={props.value} onValueChange={props.onChange} />
      <AppText variant="small">{props.label}</AppText>
    </View>
  );
}

export function Row(props: { children: ReactNode; style?: StyleProp<ViewStyle>; testID?: string }) {
  return (
    <View testID={props.testID} style={[{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm, alignItems: 'center' }, props.style]}>
      {props.children}
    </View>
  );
}

export function Spinner(props: { testID?: string }) {
  return <ActivityIndicator testID={props.testID} size="large" color={theme.color.onPrimary} />;
}
