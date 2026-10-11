/**
 * Pure state machine for one patient capture. No React, no I/O: the useCapture hook
 * performs side effects and dispatches events here. Every state listed in
 * docs/UI_CONTRACT.md corresponds to one `kind` below.
 */
import type { CaptureOut, ClinicalEvent } from '../api/types';

export interface Photo {
  uri: string;
  width: number;
  height: number;
}

export type CaptureState =
  | { kind: 'idle' }
  | { kind: 'analyzing'; slow: boolean; photo: Photo | null }
  | { kind: 'confirm'; capture: CaptureOut; photo: Photo | null; idempotencyKey: string; error: string | null }
  | { kind: 'saving'; capture: CaptureOut; photo: Photo | null; idempotencyKey: string }
  | { kind: 'saved'; event: ClinicalEvent; flagged: boolean; message: string; duplicate: boolean }
  | { kind: 'unclear'; capture: CaptureOut | null; photo: Photo | null; message: string }
  | { kind: 'rejected'; capture: CaptureOut; photo: Photo | null; message: string }
  | { kind: 'offline'; message: string }
  | { kind: 'error'; message: string };

export type CaptureEvent =
  | { type: 'ANALYZE_START'; photo: Photo | null }
  | { type: 'PHOTO_READY'; photo: Photo }
  | { type: 'ANALYZE_SLOW' }
  | { type: 'ANALYZE_DONE'; capture: CaptureOut; idempotencyKey: string }
  | { type: 'ANALYZE_FAILED'; target: 'offline' | 'error' | 'unclear'; message: string }
  | { type: 'CONFIRM_START' }
  | { type: 'CONFIRM_DONE'; event: ClinicalEvent; flagged: boolean; message: string; duplicate: boolean }
  | { type: 'CONFIRM_REJECTED'; message: string }
  | { type: 'CONFIRM_RETAKE'; message: string }
  | { type: 'CONFIRM_FAILED'; message: string }
  | { type: 'RESET' };

export const initialCaptureState: CaptureState = { kind: 'idle' };

/** True while a request is in flight: the UI must block further taps (exactly-once). */
export function isBusy(state: CaptureState): boolean {
  return state.kind === 'analyzing' || state.kind === 'saving';
}

export function captureReducer(state: CaptureState, event: CaptureEvent): CaptureState {
  switch (event.type) {
    case 'ANALYZE_START':
      if (isBusy(state)) return state;
      return { kind: 'analyzing', slow: false, photo: event.photo };

    case 'PHOTO_READY':
      return state.kind === 'analyzing' ? { ...state, photo: event.photo } : state;

    case 'ANALYZE_SLOW':
      return state.kind === 'analyzing' ? { ...state, slow: true } : state;

    case 'ANALYZE_DONE': {
      if (state.kind !== 'analyzing') return state;
      const { capture } = event;
      if (capture.status === 'needs_confirmation') {
        return { kind: 'confirm', capture, photo: state.photo, idempotencyKey: event.idempotencyKey, error: null };
      }
      if (capture.status === 'rejected') {
        return { kind: 'rejected', capture, photo: state.photo, message: capture.voice_script };
      }
      return { kind: 'unclear', capture, photo: state.photo, message: capture.voice_script };
    }

    case 'ANALYZE_FAILED':
      if (state.kind !== 'analyzing') return state;
      if (event.target === 'unclear') {
        return { kind: 'unclear', capture: null, photo: state.photo, message: event.message };
      }
      return { kind: event.target, message: event.message };

    case 'CONFIRM_START':
      if (state.kind !== 'confirm') return state;
      return { kind: 'saving', capture: state.capture, photo: state.photo, idempotencyKey: state.idempotencyKey };

    case 'CONFIRM_DONE':
      if (state.kind !== 'saving') return state;
      return {
        kind: 'saved',
        event: event.event,
        flagged: event.flagged,
        message: event.message,
        duplicate: event.duplicate,
      };

    case 'CONFIRM_REJECTED':
      if (state.kind !== 'saving') return state;
      return { kind: 'rejected', capture: state.capture, photo: state.photo, message: event.message };

    case 'CONFIRM_RETAKE':
      if (state.kind !== 'saving') return state;
      return { kind: 'unclear', capture: state.capture, photo: state.photo, message: event.message };

    case 'CONFIRM_FAILED':
      // Keep the same idempotency key so a retry can never double-count.
      if (state.kind !== 'saving') return state;
      return {
        kind: 'confirm',
        capture: state.capture,
        photo: state.photo,
        idempotencyKey: state.idempotencyKey,
        error: event.message,
      };

    case 'RESET':
      return isBusy(state) ? state : initialCaptureState;
  }
}
