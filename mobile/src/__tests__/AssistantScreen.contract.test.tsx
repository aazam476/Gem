/**
 * UI contract for the Gem assistant + permission screens. Renders every state with
 * mocked hooks and checks required testIDs and handlers (docs/UI_CONTRACT.md).
 */
import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { AssistantController } from '../hooks/useAssistant';
import { permissionStatus, type PermissionsController } from '../hooks/usePermissions';
import { initialAssistantState, type AssistantState } from '../logic/assistantState';
import { AssistantScreen } from '../screens/assistant/AssistantScreen';
import { GemRoot } from '../screens/assistant/GemRoot';
import { PermissionScreen } from '../screens/assistant/PermissionScreen';

jest.mock('../hooks/useAssistant');
jest.mock('../hooks/usePermissions', () => ({
  ...jest.requireActual('../hooks/usePermissions'),
  usePermissions: jest.fn(),
}));
const useAssistant = jest.requireMock('../hooks/useAssistant').useAssistant as jest.Mock;
const usePermissions = jest.requireMock('../hooks/usePermissions').usePermissions as jest.Mock;

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const answer = {
  turnId: 't', transcript: 'where is the start button', answer: 'It is the blue button.',
  imageUri: 'http://api/img.jpg', imageWidth: 768, imageHeight: 576, frameAgeS: 0.4, audioUrl: null,
};

function controller(state: Partial<AssistantState> = {}, extra: Partial<AssistantController> = {}): AssistantController {
  return {
    state: { ...initialAssistantState, phase: 'listening', ...state },
    attachCamera: jest.fn(),
    onCameraReady: jest.fn(),
    cameraReady: true,
    pictureSize: '1920x1080',
    micActive: true,
    micError: null,
    frames: { sent: 12, failed: 0, lastChangeScore: 0.08, remembered: 7 },
    activity: 'active',
    dismiss: jest.fn(),
    replay: jest.fn(),
    retry: jest.fn(),
    muted: false,
    toggleMute: jest.fn(),
    ...extra,
  };
}

async function renderAssistant(state: Partial<AssistantState> = {}, extra: Partial<AssistantController> = {}) {
  const ctl = controller(state, extra);
  useAssistant.mockReturnValue(ctl);
  await render(<SafeAreaProvider initialMetrics={metrics}><AssistantScreen /></SafeAreaProvider>);
  return ctl;
}

function perms(overrides: Partial<PermissionsController> = {}): PermissionsController {
  return {
    status: 'needed',
    camera: { granted: false, canAskAgain: true },
    microphone: { granted: true, canAskAgain: true },
    request: jest.fn(),
    openSettings: jest.fn(),
    ...overrides,
  };
}

describe('AssistantScreen contract', () => {
  it.each([
    ['starting', 'Starting'],
    ['listening', 'Listening'],
    ['hearing', 'Hearing you'],
    ['thinking', 'Thinking'],
  ] as const)('status for %s', async (phase, text) => {
    await renderAssistant({ phase });
    expect(screen.getByTestId('assistant-screen')).toBeTruthy();
    expect(screen.getByTestId('assistant-camera')).toBeTruthy();
    expect(screen.getByTestId('assistant-status')).toHaveTextContent(new RegExp(text));
    expect(screen.queryByTestId('assistant-thinking') !== null).toBe(phase === 'thinking');
  });

  it('shows no diagnostics to patients (frames, change score, mic on/off)', async () => {
    await renderAssistant();
    expect(screen.queryByTestId('assistant-frames')).toBeNull();
    expect(screen.queryByTestId('assistant-mic')).toBeNull();
    expect(screen.queryByText(/Frames sent|remembered|change 0|Mic on/)).toBeNull();
  });

  it('first-run hint until the first question', async () => {
    await renderAssistant();
    expect(screen.getByTestId('assistant-hint')).toBeTruthy();
    await renderAssistant({ lastTranscript: 'hello' });
    expect(screen.queryByTestId('assistant-hint')).toBeNull();
  });

  it('status says Paused while inactive', async () => {
    await renderAssistant({}, { activity: 'idle' });
    expect(screen.getByTestId('assistant-status')).toHaveTextContent('Paused');
  });

  it('shows "Speaking" while Gem talks', async () => {
    await renderAssistant({ speaking: true });
    expect(screen.getByTestId('assistant-status')).toHaveTextContent(/Speaking/);
  });

  it('never shows the previous question while thinking about a new one, and shows notices', async () => {
    await renderAssistant({ phase: 'thinking', lastTranscript: 'the previous question' });
    expect(screen.queryByTestId('assistant-heard')).toBeNull();
    expect(screen.queryByText(/the previous question/)).toBeNull();
    await renderAssistant({ lastTranscript: 'hello gem', notice: "I didn't catch that." });
    expect(screen.queryByTestId('assistant-heard')).toBeNull();
    expect(screen.getByTestId('assistant-notice')).toHaveTextContent("I didn't catch that.");
  });

  it('error state offers retry', async () => {
    const ctl = await renderAssistant({ phase: 'error', error: "I'm having trouble connecting." });
    expect(screen.getByTestId('assistant-error')).toHaveTextContent(/trouble connecting/);
    await fireEvent.press(screen.getByTestId('assistant-retry'));
    expect(ctl.retry).toHaveBeenCalled();
  });

  it('microphone error is visible', async () => {
    await renderAssistant({}, { micError: 'busy', micActive: false });
    expect(screen.getByTestId('assistant-mic-error')).toHaveTextContent(/can't hear you/);
    expect(screen.getByTestId('assistant-mic-error')).toHaveTextContent(/busy/);
  });

  it.each([
    ['idle', 'Paused'],
    ['expired', 'Gem is asleep'],
  ] as const)('inactivity %s shows how to wake Gem', async (activity, text) => {
    await renderAssistant({}, { activity });
    expect(screen.getByTestId('assistant-idle')).toHaveTextContent(new RegExp(text));
    expect(screen.getByTestId('assistant-idle')).toHaveTextContent(/Move your phone or speak/);
  });

  it('no inactivity banner while active', async () => {
    await renderAssistant();
    expect(screen.queryByTestId('assistant-idle')).toBeNull();
  });

  it('mute button: white microphone when listening, toggles on press', async () => {
    const ctl = await renderAssistant();
    expect(screen.getByTestId('assistant-mute').props.accessibilityLabel).toBe('Mute microphone');
    expect(screen.getByTestId('assistant-mute-icon-on')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('assistant-mute'));
    expect(ctl.toggleMute).toHaveBeenCalledTimes(1);
  });

  it('muted: red slashed microphone, "Muted" status, no "ask a question" hint', async () => {
    await renderAssistant({}, { muted: true });
    expect(screen.getByTestId('assistant-mute').props.accessibilityLabel).toBe('Unmute microphone');
    expect(screen.getByTestId('assistant-mute-icon-off')).toBeTruthy();
    expect(screen.getByTestId('assistant-status')).toHaveTextContent('Muted');
    expect(screen.queryByTestId('assistant-hint')).toBeNull();
  });

  it('muted and idle: only movement wakes Gem', async () => {
    await renderAssistant({}, { muted: true, activity: 'idle' });
    expect(screen.getByTestId('assistant-idle')).toHaveTextContent(/Move your phone to wake Gem\./);
  });

  it('the mute button stays usable over an answer, and the answer says how to ask', async () => {
    await renderAssistant({ answer }, { muted: true });
    expect(screen.getByTestId('assistant-mute')).toBeTruthy();
    expect(screen.getByTestId('assistant-answer-listening')).toHaveTextContent(/Muted — tap the microphone/);
  });

  it('has no typed-question box', async () => {
    await renderAssistant();
    expect(screen.queryByTestId('assistant-text-input')).toBeNull();
    expect(screen.queryByTestId('assistant-send')).toBeNull();
  });

  it('answer: image, text box, read again, dismiss', async () => {
    const ctl = await renderAssistant({ answer });
    expect(screen.getByTestId('assistant-answer')).toBeTruthy();
    expect(screen.getByTestId('assistant-answer-image').props.source).toEqual({ uri: 'http://api/img.jpg' });
    expect(screen.getByTestId('assistant-answer-box')).toBeTruthy();
    expect(screen.getByTestId('assistant-answer-text')).toHaveTextContent('It is the blue button.');
    expect(screen.getByTestId('assistant-answer')).toHaveTextContent(/where is the start button/);
    expect(screen.getByTestId('assistant-answer-listening')).toHaveTextContent(/Listening/);
    await fireEvent.press(screen.getByTestId('assistant-replay'));
    await fireEvent.press(screen.getByTestId('assistant-dismiss'));
    expect(ctl.replay).toHaveBeenCalledTimes(1);
    expect(ctl.dismiss).toHaveBeenCalledTimes(1);
  });

  it('while Gem speaks the answer says to wait; after, it is listening for a follow-up', async () => {
    await renderAssistant({ answer, speaking: true });
    expect(screen.getByTestId('assistant-answer-listening')).toHaveTextContent(/Gem is speaking/);
    await renderAssistant({ answer, phase: 'hearing' });
    expect(screen.getByTestId('assistant-answer-listening')).toHaveTextContent('Hearing you…');
  });

  it('passes the capture size to the camera', async () => {
    await renderAssistant();
    expect(screen.getByTestId('assistant-camera').props.pictureSize).toBe('1920x1080');
  });

  it('answer drawn on an earlier frame says when it was seen', async () => {
    await renderAssistant({ answer: { ...answer, frameAgeS: 58 } });
    expect(screen.getByTestId('assistant-answer-age')).toHaveTextContent(/Seen 58 seconds ago/);
  });

  it('no age label for the current view', async () => {
    await renderAssistant({ answer });
    expect(screen.queryByTestId('assistant-answer-age')).toBeNull();
  });

  it('answer without an image still shows the text', async () => {
    await renderAssistant({ answer: { ...answer, imageUri: null } });
    expect(screen.queryByTestId('assistant-answer-image')).toBeNull();
    expect(screen.getByTestId('assistant-answer-text')).toBeTruthy();
  });

  it('no answer overlay when dismissed', async () => {
    await renderAssistant({ answer: null });
    expect(screen.queryByTestId('assistant-answer')).toBeNull();
  });
});

describe('PermissionScreen contract', () => {
  async function renderPerms(p: PermissionsController) {
    await render(<SafeAreaProvider initialMetrics={metrics}><PermissionScreen permissions={p} /></SafeAreaProvider>);
  }

  it('checking', async () => {
    await renderPerms(perms({ status: 'checking', camera: null, microphone: null }));
    expect(screen.getByTestId('permission-checking')).toBeTruthy();
  });

  it('needed: shows both statuses and asks', async () => {
    const p = perms();
    await renderPerms(p);
    expect(screen.getByTestId('permission-screen')).toBeTruthy();
    expect(screen.getByTestId('permission-camera-status')).toHaveTextContent(/Camera: Not allowed/);
    expect(screen.getByTestId('permission-mic-status')).toHaveTextContent(/Microphone: Allowed/);
    await fireEvent.press(screen.getByTestId('permission-grant'));
    expect(p.request).toHaveBeenCalled();
  });

  it('blocked: sends the user to Settings', async () => {
    const p = perms({ status: 'blocked', camera: { granted: false, canAskAgain: false } });
    await renderPerms(p);
    expect(screen.getByTestId('permission-blocked')).toBeTruthy();
    expect(screen.queryByTestId('permission-grant')).toBeNull();
    await fireEvent.press(screen.getByTestId('permission-open-settings'));
    expect(p.openSettings).toHaveBeenCalled();
  });
});

describe('GemRoot', () => {
  it('gates the assistant behind both permissions', async () => {
    usePermissions.mockReturnValue(perms());
    useAssistant.mockReturnValue(controller());
    await render(<SafeAreaProvider initialMetrics={metrics}><GemRoot /></SafeAreaProvider>);
    expect(screen.getByTestId('permission-screen')).toBeTruthy();
    expect(screen.queryByTestId('assistant-screen')).toBeNull();
  });

  it('opens straight to the camera when granted', async () => {
    usePermissions.mockReturnValue(perms({ status: 'granted' }));
    useAssistant.mockReturnValue(controller());
    await render(<SafeAreaProvider initialMetrics={metrics}><GemRoot /></SafeAreaProvider>);
    expect(screen.getByTestId('assistant-screen')).toBeTruthy();
  });
});

describe('permissionStatus', () => {
  const yes = { granted: true, canAskAgain: true };
  const no = { granted: false, canAskAgain: true };
  const never = { granted: false, canAskAgain: false };
  it('needs both', () => {
    expect(permissionStatus(null, yes)).toBe('checking');
    expect(permissionStatus(yes, yes)).toBe('granted');
    expect(permissionStatus(no, yes)).toBe('needed');
    expect(permissionStatus(yes, no)).toBe('needed');
    expect(permissionStatus(yes, never)).toBe('blocked');
    expect(permissionStatus(never, no)).toBe('blocked');
  });
});
