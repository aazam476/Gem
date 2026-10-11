/**
 * Pure state for the Gem assistant screen. The useAssistant hook performs side effects
 * and dispatches events; every UI state in docs/UI_CONTRACT.md maps to fields here.
 */

export interface AssistantAnswer {
  turnId: string;
  transcript: string;
  answer: string;
  imageUri: string | null;
  imageWidth: number;
  imageHeight: number;
  /** Seconds between when the shown frame was taken and the question (0 = current view). */
  frameAgeS: number | null;
  audioUrl: string | null;
}

/** "Seen 58 seconds ago" for answers drawn on an earlier frame; null for the current view. */
export function frameAgeLabel(ageS: number | null): string | null {
  if (ageS === null || ageS < 5) return null;
  if (ageS < 90) return `Seen ${Math.round(ageS)} seconds ago`;
  const min = Math.round(ageS / 60);
  return `Seen ${min} minute${min === 1 ? '' : 's'} ago`;
}

export type AssistantPhase =
  | 'starting' //   creating the session
  | 'listening' //  mic open, waiting for speech
  | 'hearing' //    user is talking
  | 'thinking' //   prompt sent, waiting for Gemini
  | 'error'; //     could not reach the backend

export interface AssistantState {
  phase: AssistantPhase;
  speaking: boolean;
  answer: AssistantAnswer | null; // shown until dismissed
  lastTranscript: string | null;
  error: string | null;
  notice: string | null; // transient, non-blocking ("I didn't catch that")
}

export type AssistantEvent =
  | { type: 'SESSION_READY' }
  | { type: 'SESSION_FAILED'; message: string }
  | { type: 'SPEECH_START' }
  | { type: 'SPEECH_DISCARDED' }
  | { type: 'TURN_START' }
  | { type: 'TURN_ANSWERED'; answer: AssistantAnswer }
  | { type: 'TURN_IGNORED'; transcript: string }
  | { type: 'TURN_FAILED'; message: string }
  | { type: 'SPEAKING'; speaking: boolean }
  | { type: 'DISMISS' }
  | { type: 'RETRY' };

export const initialAssistantState: AssistantState = {
  phase: 'starting',
  speaking: false,
  answer: null,
  lastTranscript: null,
  error: null,
  notice: null,
};

/**
 * The mic is ignored only while a question is being answered (no queued second prompt).
 * While Gem SPEAKS the mic stays live in barge-in mode, so the user can interrupt
 * ("wait, no, the other chair").
 */
export function isMicMuted(s: AssistantState): boolean {
  return s.phase === 'starting' || s.phase === 'thinking';
}

/** Camera frames go into Gem's memory only while the user is looking through the camera,
 * not while an answer (photo + text) is on screen. */
export function shouldStreamFrames(s: AssistantState): boolean {
  return s.answer === null && s.phase !== 'starting' && s.phase !== 'error';
}

export function canSendTurn(s: AssistantState): boolean {
  return s.phase === 'listening' || s.phase === 'hearing' || s.phase === 'error';
}

export function assistantReducer(s: AssistantState, e: AssistantEvent): AssistantState {
  switch (e.type) {
    case 'SESSION_READY':
      return s.phase === 'starting' || s.phase === 'error' ? { ...s, phase: 'listening', error: null } : s;
    case 'SESSION_FAILED':
      return { ...s, phase: 'error', error: e.message };
    case 'SPEECH_START':
      return s.phase === 'listening' ? { ...s, phase: 'hearing', notice: null } : s;
    case 'SPEECH_DISCARDED':
      return s.phase === 'hearing' ? { ...s, phase: 'listening' } : s;
    case 'TURN_START':
      return canSendTurn(s) ? { ...s, phase: 'thinking', notice: null, error: null } : s;
    case 'TURN_ANSWERED':
      if (s.phase !== 'thinking') return s;
      return { ...s, phase: 'listening', answer: e.answer, lastTranscript: e.answer.transcript };
    case 'TURN_IGNORED':
      if (s.phase !== 'thinking') return s;
      return { ...s, phase: 'listening', notice: "I didn't catch that.", lastTranscript: e.transcript || s.lastTranscript };
    case 'TURN_FAILED':
      return s.phase === 'thinking' ? { ...s, phase: 'error', error: e.message } : s;
    case 'SPEAKING':
      return { ...s, speaking: e.speaking };
    case 'DISMISS':
      return { ...s, answer: null, speaking: false };
    case 'RETRY':
      return s.phase === 'error' ? { ...s, phase: 'listening', error: null } : s;
  }
}
