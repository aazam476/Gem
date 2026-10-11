/**
 * UI contract tests: render the patient screen with mocked hook values for every
 * state and check required testIDs exist and handlers fire. After a restyle, any
 * failure here shows exactly what must be reconnected. See docs/UI_CONTRACT.md.
 */
import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { ActiveProtocolState } from '../hooks/useActiveProtocol';
import type { CameraAccess } from '../hooks/useCameraAccess';
import type { CaptureController } from '../hooks/useCapture';
import type { CaptureState } from '../logic/captureMachine';
import { PatientScreen } from '../screens/patient/PatientScreen';
import { capture, event, protocol } from '../testing/fixtures';

jest.mock('../hooks/useActiveProtocol');
jest.mock('../hooks/useCameraAccess');
jest.mock('../hooks/useCapture');

const useActiveProtocol = jest.requireMock('../hooks/useActiveProtocol').useActiveProtocol as jest.Mock;
const useCameraAccess = jest.requireMock('../hooks/useCameraAccess').useCameraAccess as jest.Mock;
const useCapture = jest.requireMock('../hooks/useCapture').useCapture as jest.Mock;

const photo = { uri: 'file://small.jpg', width: 768, height: 1024 };

function protocolState(overrides: Partial<ActiveProtocolState> = {}): ActiveProtocolState {
  return { status: 'ready', protocol, error: null, refresh: jest.fn(), ...overrides };
}

function controller(state: CaptureState, overrides: Partial<CaptureController> = {}): CaptureController {
  return {
    state,
    busy: state.kind === 'analyzing' || state.kind === 'saving',
    attachCamera: jest.fn(),
    cameraReady: true,
    onCameraReady: jest.fn(),
    analyze: jest.fn(),
    confirm: jest.fn(),
    retake: jest.fn(),
    repeatVoice: jest.fn(),
    ...overrides,
  };
}

async function renderWith(state: CaptureState, overrides: Partial<CaptureController> = {}) {
  const ctl = controller(state, overrides);
  useCapture.mockReturnValue(ctl);
  await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <PatientScreen />
    </SafeAreaProvider>,
  );
  return ctl;
}

beforeEach(() => {
  useActiveProtocol.mockReturnValue(protocolState());
  useCameraAccess.mockReturnValue({ granted: true, canAskAgain: true, request: jest.fn() } satisfies CameraAccess);
});

describe('PatientScreen contract', () => {
  it('loading protocol', async () => {
    useActiveProtocol.mockReturnValue(protocolState({ status: 'loading', protocol: null }));
    await renderWith({ kind: 'idle' });
    expect(screen.getByTestId('patient-loading')).toBeTruthy();
  });

  it('no protocol deployed: retry fires refresh', async () => {
    const ps = protocolState({ status: 'none', protocol: null });
    useActiveProtocol.mockReturnValue(ps);
    await renderWith({ kind: 'idle' });
    expect(screen.getByTestId('patient-no-protocol')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('patient-retry-protocol'));
    expect(ps.refresh).toHaveBeenCalled();
  });

  it('backend unreachable', async () => {
    useActiveProtocol.mockReturnValue(protocolState({ status: 'offline', protocol: null }));
    await renderWith({ kind: 'idle' });
    expect(screen.getByTestId('patient-offline')).toBeTruthy();
    expect(screen.getByTestId('patient-retry-protocol')).toBeTruthy();
  });

  it('camera permission prompt', async () => {
    const access = { granted: false, canAskAgain: true, request: jest.fn() };
    useCameraAccess.mockReturnValue(access);
    await renderWith({ kind: 'idle' });
    await fireEvent.press(screen.getByTestId('patient-grant-camera'));
    expect(access.request).toHaveBeenCalled();
  });

  it('idle: instructions, camera, analyze', async () => {
    const ctl = await renderWith({ kind: 'idle' });
    expect(screen.getByTestId('patient-instructions')).toHaveTextContent(protocol.prompt_text);
    expect(screen.getByTestId('patient-camera')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('patient-analyze'));
    expect(ctl.analyze).toHaveBeenCalledTimes(1);
  });

  it('idle: analyze disabled until the camera is ready', async () => {
    const ctl = await renderWith({ kind: 'idle' }, { cameraReady: false });
    await fireEvent.press(screen.getByTestId('patient-analyze'));
    expect(ctl.analyze).not.toHaveBeenCalled();
  });

  it('analyzing: blocking overlay, slow notice, no double submit', async () => {
    const ctl = await renderWith({ kind: 'analyzing', slow: true, photo });
    expect(screen.getByTestId('patient-busy-overlay')).toBeTruthy();
    expect(screen.getByTestId('patient-slow-notice')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('patient-analyze'));
    expect(ctl.analyze).not.toHaveBeenCalled();
  });

  it('confirm: readings, box, yes/no, repeat', async () => {
    const ctl = await renderWith({ kind: 'confirm', capture: capture(), photo, idempotencyKey: 'k', error: null });
    expect(screen.getByTestId('patient-readings')).toHaveTextContent(/142\/90 mmHg/);
    expect(screen.getByTestId('patient-voice-text')).toHaveTextContent(/I read 142 over 90/);
    expect(screen.getByTestId('patient-photo')).toBeTruthy();
    await fireEvent(screen.getByTestId('patient-viewport'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 520 } },
    });
    expect(screen.getByTestId('patient-bounding-box', { includeHiddenElements: true })).toBeTruthy();
    await fireEvent.press(screen.getByTestId('patient-confirm-yes'));
    await fireEvent.press(screen.getByTestId('patient-confirm-no'));
    await fireEvent.press(screen.getByTestId('patient-repeat-voice'));
    expect(ctl.confirm).toHaveBeenCalledTimes(1);
    expect(ctl.retake).toHaveBeenCalledTimes(1);
    expect(ctl.repeatVoice).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('patient-flag-notice')).toBeNull();
  });

  it('confirm: flagged reading and retryable error', async () => {
    await renderWith({
      kind: 'confirm',
      capture: capture({ flags: [{ code: 'above_range', metric: 'systolic', message: 'high' }] }),
      photo,
      idempotencyKey: 'k',
      error: 'No connection',
    });
    expect(screen.getByTestId('patient-flag-notice')).toBeTruthy();
    expect(screen.getByTestId('patient-confirm-error')).toHaveTextContent('No connection');
  });

  it('saving: overlay shown, confirm cannot fire twice', async () => {
    const ctl = await renderWith({ kind: 'saving', capture: capture(), photo, idempotencyKey: 'k' });
    expect(screen.getByTestId('patient-busy-overlay')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('patient-confirm-yes'));
    expect(ctl.confirm).not.toHaveBeenCalled();
  });

  it('saved (flagged): message and done', async () => {
    const ctl = await renderWith({ kind: 'saved', event: { ...event, status: 'flagged' }, flagged: true, message: 'Thank you.', duplicate: false });
    expect(screen.getByTestId('patient-saved')).toBeTruthy();
    expect(screen.getByTestId('patient-saved-readings')).toHaveTextContent(/142\/90 mmHg/);
    expect(screen.getByTestId('patient-flag-notice')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('patient-done'));
    expect(ctl.retake).toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'unclear', capture: null, photo, message: "I couldn't quite see that clearly." }, 'patient-unclear'],
    [{ kind: 'rejected', capture: capture({ status: 'rejected' }), photo, message: 'That reading looks unusual.' }, 'patient-rejected'],
    [{ kind: 'offline', message: "I'm having trouble connecting." }, 'patient-offline'],
    [{ kind: 'error', message: 'Something went wrong.' }, 'patient-error'],
  ] as [CaptureState, string][])('retry state %#', async (state, testID) => {
    const ctl = await renderWith(state);
    expect(screen.getByTestId(testID)).toBeTruthy();
    expect(screen.getByTestId('patient-voice-text')).toHaveTextContent((state as { message: string }).message);
    await fireEvent.press(screen.getByTestId('patient-try-again'));
    expect(ctl.retake).toHaveBeenCalled();
  });
});
