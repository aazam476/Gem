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
  const recorder = {
    prepareToRecordAsync: jest.fn(async () => undefined),
    record: jest.fn(),
    stop: jest.fn(async () => undefined),
    getStatus: jest.fn(() => ({ isRecording: true, metering: -60 })),
    uri: 'file://cache/barge.wav',
  };
  return {
    IOSOutputFormat: { LINEARPCM: 'lpcm' },
    AudioQuality: { MAX: 127 },
    useAudioRecorder: jest.fn(() => recorder),
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
    arrayBuffer = jest.fn(async () => (File.nextBytes ?? new Uint8Array(0)).buffer);
    static nextBytes: Uint8Array | null = null;
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

jest.mock('expo-sensors', () => {
  const make = () => {
    const listeners: ((v: { x: number; y: number; z: number }) => void)[] = [];
    return {
      setUpdateInterval: jest.fn(),
      addListener: jest.fn((cb: (v: { x: number; y: number; z: number }) => void) => {
        listeners.push(cb);
        return { remove: jest.fn(() => listeners.splice(listeners.indexOf(cb), 1)) };
      }),
      emit: (v: { x: number; y: number; z: number }) => listeners.forEach((l) => l(v)),
    };
  };
  return { Accelerometer: make(), Gyroscope: make() };
});

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(async () => ({ canceled: true, assets: null })),
}));
