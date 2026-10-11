import { useCameraPermissions } from 'expo-camera';
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from 'expo-audio';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking } from 'react-native';

export type PermissionStatus = 'checking' | 'granted' | 'needed' | 'blocked';

export interface PermissionInfo {
  granted: boolean;
  canAskAgain: boolean;
}

export interface PermissionsController {
  status: PermissionStatus;
  camera: PermissionInfo | null;
  microphone: PermissionInfo | null;
  /** Ask for whatever is missing (system dialogs). */
  request: () => void;
  /** When the OS won't ask again, the user must enable access in Settings. */
  openSettings: () => void;
}

export function permissionStatus(camera: PermissionInfo | null, mic: PermissionInfo | null): PermissionStatus {
  if (!camera || !mic) return 'checking';
  if (camera.granted && mic.granted) return 'granted';
  if ((!camera.granted && !camera.canAskAgain) || (!mic.granted && !mic.canAskAgain)) return 'blocked';
  return 'needed';
}

/** Camera + microphone, both required before Gem starts. Re-checks when the app returns from Settings. */
export function usePermissions(): PermissionsController {
  const [cameraPermission, requestCamera, getCamera] = useCameraPermissions();
  const [mic, setMic] = useState<PermissionInfo | null>(null);

  const refreshMic = useCallback(() => {
    getRecordingPermissionsAsync()
      .then((p) => setMic({ granted: p.granted, canAskAgain: p.canAskAgain }))
      .catch(() => setMic({ granted: false, canAskAgain: true }));
  }, []);

  useEffect(() => {
    refreshMic();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        refreshMic();
        void getCamera();
      }
    });
    return () => sub.remove();
  }, [refreshMic, getCamera]);

  const camera = cameraPermission
    ? { granted: cameraPermission.granted, canAskAgain: cameraPermission.canAskAgain }
    : null;

  return {
    status: permissionStatus(camera, mic),
    camera,
    microphone: mic,
    request: () => {
      void (async () => {
        if (!cameraPermission?.granted) await requestCamera();
        if (!mic?.granted) {
          const p = await requestRecordingPermissionsAsync();
          setMic({ granted: p.granted, canAskAgain: p.canAskAgain });
        }
      })();
    },
    openSettings: () => {
      void Linking.openSettings();
    },
  };
}
