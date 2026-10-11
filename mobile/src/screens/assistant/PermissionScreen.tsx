/**
 * Shown until camera AND microphone are granted. Contract: docs/UI_CONTRACT.md §Permissions.
 * First-run only, so it gets a short staggered entrance (rare tier: 250 ms, 60 ms apart).
 */
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import type { PermissionsController } from '../../hooks/usePermissions';
import { DURATION, EASE_OUT } from '../../ui/motion';
import { AppText, Button, Ionicons, Pill, Screen, Spinner, type IconName } from '../../ui/primitives';
import { theme } from '../../ui/theme';

const STAGGER_MS = 60;
const enter = (i: number) => FadeInDown.duration(DURATION.enter).easing(EASE_OUT).delay(i * STAGGER_MS);
const ENTER = [enter(0), enter(1), enter(2), enter(3)];
const FADE = FadeIn.duration(DURATION.enter).easing(EASE_OUT);

function label(p: { granted: boolean } | null): string {
  if (!p) return 'Checking…';
  return p.granted ? 'Allowed' : 'Not allowed';
}

function PermissionRow(props: {
  icon: IconName;
  name: string;
  why: string;
  value: { granted: boolean } | null;
  testID: string;
}) {
  const granted = !!props.value?.granted;
  return (
    <View style={styles.row}>
      <View style={styles.rowIcon}>
        <Ionicons name={props.icon} size={24} color={theme.color.primary} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <AppText variant="patient" weight="600" testID={props.testID}>{`${props.name}: ${label(props.value)}`}</AppText>
        <AppText variant="body" tone="muted">
          {props.why}
        </AppText>
      </View>
      <Pill
        label={granted ? 'On' : 'Off'}
        icon={granted ? 'checkmark' : 'close'}
        tone={granted ? 'success' : 'neutral'}
      />
    </View>
  );
}

export function PermissionScreen({ permissions }: { permissions: PermissionsController }) {
  const { status, camera, microphone } = permissions;
  if (status === 'checking') {
    return (
      <Screen testID="permission-checking">
        <View style={styles.center}>
          <Spinner color={theme.color.textMuted} />
          <AppText variant="patient" tone="muted">
            Checking permissions…
          </AppText>
        </View>
      </Screen>
    );
  }
  return (
    <Screen testID="permission-screen" scroll>
      <View style={styles.content}>
        <Animated.View entering={ENTER[0]} style={styles.hero}>
          <View style={styles.logo}>
            <Ionicons name="sparkles" size={36} color={theme.color.onPrimary} />
          </View>
          <AppText variant="hero" align="center">
            Gem needs your camera and microphone
          </AppText>
          <AppText variant="patient" tone="muted" align="center">
            Gem looks through your camera and listens for your questions, so it can help with what is in front of you.
            Both are required.
          </AppText>
        </Animated.View>

        <Animated.View entering={ENTER[1]} style={styles.group}>
          <PermissionRow
            icon="camera"
            name="Camera"
            why="To see what you are pointing at"
            value={camera}
            testID="permission-camera-status"
          />
          <View style={styles.separator} />
          <PermissionRow
            icon="mic"
            name="Microphone"
            why="To hear your questions"
            value={microphone}
            testID="permission-mic-status"
          />
        </Animated.View>

        {status === 'blocked' ? (
          <Animated.View entering={FADE} style={styles.actions}>
            <AppText variant="patient" tone="danger" align="center" testID="permission-blocked">
              {"Access was turned off. Please allow the camera and microphone for Gem in your phone's Settings."}
            </AppText>
            <Button testID="permission-open-settings" label="Open Settings" icon="settings-outline" onPress={permissions.openSettings} />
          </Animated.View>
        ) : (
          <Animated.View entering={ENTER[2]} style={styles.actions}>
            <Button testID="permission-grant" label="Allow camera and microphone" onPress={permissions.request} />
            <AppText variant="small" tone="muted" align="center">
              Gem only sees and hears while it is open, and forgets everything soon after you stop using it.
            </AppText>
          </Animated.View>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: theme.space.md },
  content: { width: '100%', maxWidth: 520, alignSelf: 'center', gap: theme.space.lg, paddingTop: theme.space.xl },
  hero: { alignItems: 'center', gap: theme.space.md },
  logo: {
    width: 72,
    height: 72,
    borderRadius: 20,
    backgroundColor: theme.color.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  group: {
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    paddingHorizontal: theme.space.md,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.space.md, paddingVertical: theme.space.md },
  rowIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: theme.color.secondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: theme.color.separator, marginLeft: 60 },
  actions: { gap: theme.space.md },
});
