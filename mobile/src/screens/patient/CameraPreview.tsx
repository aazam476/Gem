import { CameraView } from 'expo-camera';
import { StyleSheet } from 'react-native';

export function CameraPreview({
  attachCamera,
  onReady,
}: {
  attachCamera: (camera: CameraView | null) => void;
  onReady: () => void;
}) {
  return (
    <CameraView
      testID="patient-camera"
      ref={attachCamera}
      style={StyleSheet.absoluteFill}
      facing="back"
      animateShutter={false}
      onCameraReady={onReady}
    />
  );
}
