/** Shown until camera AND microphone are granted. Contract: docs/UI_CONTRACT.md §Permissions. */
import type { PermissionsController } from '../../hooks/usePermissions';
import { AppText, Button, Card, Screen } from '../../ui/primitives';

function label(p: { granted: boolean } | null): string {
  if (!p) return 'Checking…';
  return p.granted ? 'Allowed' : 'Not allowed';
}

export function PermissionScreen({ permissions }: { permissions: PermissionsController }) {
  const { status, camera, microphone } = permissions;
  if (status === 'checking') {
    return (
      <Screen testID="permission-checking">
        <AppText variant="patient">Checking permissions…</AppText>
      </Screen>
    );
  }
  return (
    <Screen testID="permission-screen">
      <AppText variant="title">Gem needs your camera and microphone</AppText>
      <AppText variant="patient" tone="muted">
        Gem looks through your camera and listens for your questions so it can help with what is in front of you.
        Both are required.
      </AppText>
      <Card>
        <AppText variant="patient" testID="permission-camera-status">{`Camera: ${label(camera)}`}</AppText>
        <AppText variant="patient" testID="permission-mic-status">{`Microphone: ${label(microphone)}`}</AppText>
      </Card>
      {status === 'blocked' ? (
        <>
          <AppText variant="patient" tone="danger" testID="permission-blocked">
            {"Access was turned off. Please allow the camera and microphone for Gem in your phone's Settings."}
          </AppText>
          <Button testID="permission-open-settings" label="Open Settings" onPress={permissions.openSettings} />
        </>
      ) : (
        <Button testID="permission-grant" label="Allow camera and microphone" onPress={permissions.request} />
      )}
    </Screen>
  );
}
