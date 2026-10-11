// Native modules are mocked so tests run in Node without a device.

jest.mock('expo-camera', () => {
  const React = require('react');
  const { View } = require('react-native');
  const CameraView = React.forwardRef((props: Record<string, unknown>, ref: unknown) => {
    React.useImperativeHandle(ref, () => ({
      takePictureAsync: jest.fn(async () => ({ uri: 'file://photo.jpg', width: 3000, height: 4000 })),
    }));
    return React.createElement(View, { testID: props.testID });
  });
  return {
    CameraView,
    useCameraPermissions: jest.fn(() => [{ granted: true, canAskAgain: true }, jest.fn(), jest.fn()]),
  };
});

jest.mock('expo-audio', () => {
  const stream = { start: jest.fn(async () => undefined), stop: jest.fn() };
  return {
    createAudioPlayer: jest.fn(() => ({
      play: jest.fn(),
      pause: jest.fn(),
      remove: jest.fn(),
      seekTo: jest.fn(async () => undefined),
      playing: false,
      addListener: jest.fn(() => ({ remove: jest.fn() })),
    })),
    setAudioModeAsync: jest.fn(async () => undefined),
    useAudioStream: jest.fn(() => ({ stream, isStreaming: false })),
    getRecordingPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true })),
    requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true })),
  };
});

jest.mock('expo-speech', () => ({
  speak: jest.fn(),
  stop: jest.fn(async () => undefined),
}));

jest.mock('expo-crypto', () => {
  let n = 0;
  return { randomUUID: jest.fn(() => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`) };
});

jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
  ImageManipulator: {
    manipulate: jest.fn(() => {
      const ctx: { resize: jest.Mock; renderAsync: jest.Mock } = {
        resize: jest.fn((): unknown => ctx),
        renderAsync: jest.fn(async () => ({
          saveAsync: jest.fn(async () => ({ uri: 'file://small.jpg', width: 576, height: 768, base64: 'QUJD' })),
        })),
      };
      return ctx;
    }),
  },
}));

jest.mock('expo-file-system', () => {
  class Directory {
    uri: string;
    exists = true;
    constructor(...parts: unknown[]) {
      this.uri = parts.map((p) => (typeof p === 'string' ? p : (p as { uri: string }).uri)).join('/');
    }
    create() {
      this.exists = true;
    }
  }
  class File {
    uri: string;
    exists = false;
    size = 0;
    delete = jest.fn();
    constructor(...parts: unknown[]) {
      this.uri = 'file://' + parts.map((p) => (typeof p === 'string' ? p : (p as { uri: string }).uri)).join('/');
    }
    static downloadFileAsync = jest.fn(async (_url: string, target: File) => {
      target.exists = true;
      target.size = 24_000;
      return target;
    });
  }
  return { Directory, File, Paths: { cache: new Directory('cache') } };
});
