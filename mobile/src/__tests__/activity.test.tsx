import { act, renderHook } from '@testing-library/react-native';
import { Accelerometer, Gyroscope } from 'expo-sensors';

import { useActivity } from '../hooks/useActivity';
import { ActivityTracker } from '../logic/activity';

type Emitter = { emit: (v: { x: number; y: number; z: number }) => void };

describe('ActivityTracker', () => {
  it('goes idle after 1 minute and expires after 10 minutes without activity', () => {
    const t = new ActivityTracker(0);
    expect(t.state(59_999)).toBe('active');
    expect(t.state(60_000)).toBe('idle');
    expect(t.state(599_999)).toBe('idle');
    expect(t.state(600_000)).toBe('expired');
  });

  it('phone lying still on a table is not activity; picking it up is', () => {
    const t = new ActivityTracker(0);
    const still = { x: 0.001, y: -0.002, z: -1.0 };
    for (let ms = 0; ms < 70_000; ms += 200) t.noteAcceleration(ms, { ...still, x: still.x + (ms % 400 ? 0.003 : 0) });
    expect(t.state(70_000)).toBe('idle');
    expect(t.noteAcceleration(70_200, { x: 0.2, y: -0.3, z: -0.9 })).toBe(true);
    expect(t.state(70_200)).toBe('active');
  });

  it('rotation counts as movement; tiny gyro noise does not', () => {
    const t = new ActivityTracker(0);
    expect(t.noteRotation(1_000, { x: 0.01, y: 0.02, z: 0.01 })).toBe(false);
    expect(t.noteRotation(2_000, { x: 0.5, y: 0, z: 0 })).toBe(true);
    expect(t.lastActivity).toEqual({ at: 2_000, reason: 'motion' });
  });

  it('a dramatic scene change counts; small camera noise does not', () => {
    const t = new ActivityTracker(0);
    expect(t.noteFrameChange(30_000, 0.01)).toBe(false);
    expect(t.noteFrameChange(30_000, null)).toBe(false);
    expect(t.state(65_000)).toBe('idle');
    expect(t.noteFrameChange(66_000, 0.3)).toBe(true);
    expect(t.state(66_000)).toBe('active');
  });

  it('speech, taps and Gem being busy wake it, even after expiry', () => {
    const t = new ActivityTracker(0);
    expect(t.state(700_000)).toBe('expired');
    t.mark(700_000, 'speech');
    expect(t.state(700_001)).toBe('active');
  });
});

describe('useActivity', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('reports idle then expired, and wakes on movement', async () => {
    const { result } = await renderHook(() => useActivity());
    expect(result.current.state).toBe('active');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(61_000);
    });
    expect(result.current.state).toBe('idle');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(540_000);
    });
    expect(result.current.state).toBe('expired');
    await act(async () => {
      (Accelerometer as unknown as Emitter).emit({ x: 0, y: 0, z: -1 });
      (Accelerometer as unknown as Emitter).emit({ x: 0.3, y: 0.1, z: -0.8 });
    });
    expect(result.current.state).toBe('active');
  });

  it('speech or a scene change keeps it active', async () => {
    const { result } = await renderHook(() => useActivity());
    await act(async () => {
      await jest.advanceTimersByTimeAsync(50_000);
      result.current.note('speech');
      await jest.advanceTimersByTimeAsync(50_000);
      result.current.noteFrameChange(0.5);
      await jest.advanceTimersByTimeAsync(50_000);
    });
    expect(result.current.state).toBe('active');
    await act(async () => {
      (Gyroscope as unknown as Emitter).emit({ x: 1, y: 0, z: 0 });
      await jest.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current.state).toBe('active');
  });
});
