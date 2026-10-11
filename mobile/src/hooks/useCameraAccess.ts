import { useCameraPermissions } from 'expo-camera';

export interface CameraAccess {
  /** null while the permission status is still loading */
  granted: boolean | null;
  canAskAgain: boolean;
  request: () => void;
}

export function useCameraAccess(): CameraAccess {
  const [permission, requestPermission] = useCameraPermissions();
  return {
    granted: permission ? permission.granted : null,
    canAskAgain: permission ? permission.canAskAgain : true,
    request: () => {
      void requestPermission();
    },
  };
}
