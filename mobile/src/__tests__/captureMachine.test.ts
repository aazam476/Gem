import { captureReducer, initialCaptureState, isBusy, type CaptureState } from '../logic/captureMachine';
import { capture, event } from '../testing/fixtures';

const photo = { uri: 'file://x.jpg', width: 768, height: 1024 };

function run(...events: Parameters<typeof captureReducer>[1][]): CaptureState {
  return events.reduce(captureReducer, initialCaptureState);
}

describe('captureReducer', () => {
  it('idle -> analyzing -> confirm', () => {
    const s = run(
      { type: 'ANALYZE_START', photo: null },
      { type: 'PHOTO_READY', photo },
      { type: 'ANALYZE_DONE', capture: capture(), idempotencyKey: 'k' },
    );
    expect(s.kind).toBe('confirm');
    if (s.kind === 'confirm') {
      expect(s.photo).toEqual(photo);
      expect(s.idempotencyKey).toBe('k');
    }
  });

  it('ignores a second analyze while busy (exactly-once)', () => {
    const busy = run({ type: 'ANALYZE_START', photo: null });
    expect(isBusy(busy)).toBe(true);
    expect(captureReducer(busy, { type: 'ANALYZE_START', photo })).toBe(busy);
    expect(captureReducer(busy, { type: 'RESET' })).toBe(busy);
  });

  it('marks slow requests', () => {
    const s = run({ type: 'ANALYZE_START', photo: null }, { type: 'ANALYZE_SLOW' });
    expect(s).toMatchObject({ kind: 'analyzing', slow: true });
  });

  it.each([
    ['unreadable', 'unclear'],
    ['rejected', 'rejected'],
  ] as const)('status %s -> %s', (status, kind) => {
    const s = run(
      { type: 'ANALYZE_START', photo: null },
      { type: 'ANALYZE_DONE', capture: capture({ status, voice_script: 'msg' }), idempotencyKey: 'k' },
    );
    expect(s).toMatchObject({ kind, message: 'msg' });
  });

  it.each(['offline', 'error', 'unclear'] as const)('analyze failure -> %s', (target) => {
    const s = run({ type: 'ANALYZE_START', photo: null }, { type: 'ANALYZE_FAILED', target, message: 'm' });
    expect(s.kind).toBe(target);
  });

  it('confirm -> saving -> saved', () => {
    const s = run(
      { type: 'ANALYZE_START', photo: null },
      { type: 'ANALYZE_DONE', capture: capture(), idempotencyKey: 'k' },
      { type: 'CONFIRM_START' },
      { type: 'CONFIRM_DONE', event, flagged: false, message: 'Saved', duplicate: false },
    );
    expect(s).toMatchObject({ kind: 'saved', flagged: false, message: 'Saved' });
  });

  it('failed confirm keeps the same idempotency key for retry', () => {
    const s = run(
      { type: 'ANALYZE_START', photo: null },
      { type: 'ANALYZE_DONE', capture: capture(), idempotencyKey: 'same-key' },
      { type: 'CONFIRM_START' },
      { type: 'CONFIRM_FAILED', message: 'offline' },
    );
    expect(s).toMatchObject({ kind: 'confirm', idempotencyKey: 'same-key', error: 'offline' });
  });

  it('gateway rejection at confirm -> rejected', () => {
    const s = run(
      { type: 'ANALYZE_START', photo: null },
      { type: 'ANALYZE_DONE', capture: capture(), idempotencyKey: 'k' },
      { type: 'CONFIRM_START' },
      { type: 'CONFIRM_REJECTED', message: 'unusual' },
    );
    expect(s).toMatchObject({ kind: 'rejected', message: 'unusual' });
  });

  it('expired capture at confirm -> unclear (retake)', () => {
    const s = run(
      { type: 'ANALYZE_START', photo: null },
      { type: 'ANALYZE_DONE', capture: capture(), idempotencyKey: 'k' },
      { type: 'CONFIRM_START' },
      { type: 'CONFIRM_RETAKE', message: 'again' },
    );
    expect(s).toMatchObject({ kind: 'unclear', message: 'again' });
  });

  it('confirm is ignored unless awaiting confirmation', () => {
    expect(captureReducer(initialCaptureState, { type: 'CONFIRM_START' })).toBe(initialCaptureState);
  });

  it('reset returns to idle from a terminal state', () => {
    const s = run({ type: 'ANALYZE_START', photo: null }, { type: 'ANALYZE_FAILED', target: 'offline', message: 'm' });
    expect(captureReducer(s, { type: 'RESET' })).toEqual(initialCaptureState);
  });
});
