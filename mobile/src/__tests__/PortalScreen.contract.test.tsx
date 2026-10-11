/** UI contract tests for the researcher portal. See docs/UI_CONTRACT.md. */
import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { PortalController } from '../hooks/usePortal';
import { draftFromRules } from '../logic/rulesForm';
import { PortalScreen } from '../screens/portal/PortalScreen';
import { event, protocol } from '../testing/fixtures';

jest.mock('../hooks/usePortal');
const usePortal = jest.requireMock('../hooks/usePortal').usePortal as jest.Mock;

function controller(overrides: Partial<PortalController> = {}): PortalController {
  return {
    health: { status: 'ok', ai_mode: 'mock', voice_enabled: false, gemini_model: 'gemini-3.6-flash', active_protocol_id: 'p-1' },
    connected: true,
    protocols: [protocol, { ...protocol, protocol_id: 'p-0', title: 'Old', is_active: false }],
    activeProtocol: protocol,
    events: [event, { ...event, event_id: 'e-2', status: 'flagged' }],
    rejections: [
      {
        rejection_id: 'r-1', protocol_id: 'p-1', patient_id: 'patient-demo-001', session_id: 's', capture_id: 'c',
        idempotency_key: null, readings: { systolic: 900 }, validation_ns: 1500, timestamp: '2026-10-11T00:00:00Z',
        errors: [{ code: 'implausible', metric: 'systolic', message: 'systolic=900 is outside plausible limits' }],
      },
    ],
    metrics: { validation: { count: 3, p50_us: 2, p95_us: 3, p99_us: 4, max_us: 5, mean_us: 2 }, events_stored: 2 },
    draft: { title: 'BP', promptText: 'Read it', rules: draftFromRules(protocol.validation_rules) },
    formErrors: [],
    deploying: false,
    deployMessage: null,
    setTitle: jest.fn(),
    setPromptText: jest.fn(),
    updateMetric: jest.fn(),
    addMetric: jest.fn(),
    removeMetric: jest.fn(),
    setSystolicAboveDiastolic: jest.fn(),
    loadBloodPressurePreset: jest.fn(),
    deploy: jest.fn(),
    activate: jest.fn(),
    deactivate: jest.fn(),
    refresh: jest.fn(),
    ...overrides,
  };
}

async function renderWith(overrides: Partial<PortalController> = {}) {
  const ctl = controller(overrides);
  usePortal.mockReturnValue(ctl);
  await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 1280, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <PortalScreen />
    </SafeAreaProvider>,
  );
  return ctl;
}

describe('PortalScreen contract', () => {
  it('editor fields and actions are wired', async () => {
    const ctl = await renderWith();
    await fireEvent.changeText(screen.getByTestId('portal-title-input'), 'New');
    await fireEvent.changeText(screen.getByTestId('portal-prompt-input'), 'Do it');
    await fireEvent.changeText(screen.getByTestId('portal-metric-0-hard_max'), '250');
    await fireEvent.changeText(screen.getByTestId('portal-metric-1-name'), 'dia');
    await fireEvent(screen.getByTestId('portal-metric-2-required'), 'valueChange', true);
    await fireEvent.press(screen.getByTestId('portal-metric-2-remove'));
    await fireEvent.press(screen.getByTestId('portal-add-metric'));
    await fireEvent(screen.getByTestId('portal-cross-field'), 'valueChange', false);
    await fireEvent.press(screen.getByTestId('portal-load-bp-preset'));
    await fireEvent.press(screen.getByTestId('portal-deploy'));
    expect(ctl.setTitle).toHaveBeenCalledWith('New');
    expect(ctl.setPromptText).toHaveBeenCalledWith('Do it');
    expect(ctl.updateMetric).toHaveBeenCalledWith(0, 'hard_max', '250');
    expect(ctl.updateMetric).toHaveBeenCalledWith(1, 'name', 'dia');
    expect(ctl.updateMetric).toHaveBeenCalledWith(2, 'required', true);
    expect(ctl.removeMetric).toHaveBeenCalledWith(2);
    expect(ctl.addMetric).toHaveBeenCalled();
    expect(ctl.setSystolicAboveDiastolic).toHaveBeenCalledWith(false);
    expect(ctl.loadBloodPressurePreset).toHaveBeenCalled();
    expect(ctl.deploy).toHaveBeenCalled();
  });

  it('every metric row exposes all limit inputs', async () => {
    await renderWith();
    for (const i of [0, 1, 2]) {
      for (const f of ['name', 'label', 'unit', 'min', 'max', 'hard_min', 'hard_max', 'required', 'remove']) {
        expect(screen.getByTestId(`portal-metric-${i}-${f}`)).toBeTruthy();
      }
    }
  });

  it('form errors and deploy message', async () => {
    await renderWith({ formErrors: ['Give the protocol a title.'], deployMessage: 'Deployed "BP".' });
    expect(screen.getByTestId('portal-form-errors')).toHaveTextContent(/Give the protocol a title/);
    expect(screen.getByTestId('portal-deploy-message')).toBeTruthy();
  });

  it('protocol list activate/deactivate', async () => {
    const ctl = await renderWith();
    await fireEvent.press(screen.getByTestId('portal-deactivate-p-1'));
    await fireEvent.press(screen.getByTestId('portal-activate-p-0'));
    expect(ctl.deactivate).toHaveBeenCalledWith('p-1');
    expect(ctl.activate).toHaveBeenCalledWith('p-0');
  });

  it('results: events, rejections, latency', async () => {
    await renderWith();
    expect(screen.getByTestId('portal-event-e-1')).toHaveTextContent(/Accepted/);
    expect(screen.getByTestId('portal-event-e-2')).toHaveTextContent(/Flagged/);
    expect(screen.getByTestId('portal-rejection-r-1')).toHaveTextContent(/900/);
    expect(screen.getByTestId('portal-latency')).toHaveTextContent(/p95 3 µs/);
  });

  it('empty and disconnected states', async () => {
    await renderWith({ connected: false, protocols: [], events: [], rejections: [], metrics: null });
    expect(screen.getByTestId('portal-connection')).toHaveTextContent(/Cannot reach/);
    expect(screen.getByTestId('portal-protocols-empty')).toBeTruthy();
    expect(screen.getByTestId('portal-events-empty')).toBeTruthy();
    expect(screen.getByTestId('portal-rejections-empty')).toBeTruthy();
  });
});
