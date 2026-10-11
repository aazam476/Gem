import {
  assistantReducer,
  frameAgeLabel,
  canSendTurn,
  initialAssistantState,
  isMicMuted,
  shouldStreamFrames,
  type AssistantEvent,
  type AssistantState,
} from '../logic/assistantState';

const answer = {
  turnId: 't', transcript: 'what is this', answer: 'A cuff.', imageUri: 'http://x/img',
  imageWidth: 768, imageHeight: 576, frameAgeS: 0, audioUrl: null,
};

const run = (...events: AssistantEvent[]): AssistantState => events.reduce(assistantReducer, initialAssistantState);

describe('assistantReducer', () => {
  it('starts muted, then listens once the session is ready', () => {
    expect(isMicMuted(initialAssistantState)).toBe(true);
    const s = run({ type: 'SESSION_READY' });
    expect(s.phase).toBe('listening');
    expect(isMicMuted(s)).toBe(false);
  });

  it('listening -> hearing -> thinking -> answer shown', () => {
    const s = run(
      { type: 'SESSION_READY' },
      { type: 'SPEECH_START' },
      { type: 'TURN_START' },
      { type: 'TURN_ANSWERED', answer },
    );
    expect(s).toMatchObject({ phase: 'listening', answer, lastTranscript: 'what is this' });
  });

  it('mutes the mic while Gem thinks and while it speaks; listens again after', () => {
    const thinking = run({ type: 'SESSION_READY' }, { type: 'TURN_START' });
    expect(isMicMuted(thinking)).toBe(true);
    expect(canSendTurn(thinking)).toBe(false);
    const speaking = run(
      { type: 'SESSION_READY' }, { type: 'TURN_START' }, { type: 'TURN_ANSWERED', answer },
      { type: 'SPEAKING', speaking: true },
    );
    expect(isMicMuted(speaking)).toBe(true); // no interrupting: Gem's voice isn't a question
    const done = assistantReducer(speaking, { type: 'SPEAKING', speaking: false });
    expect(isMicMuted(done)).toBe(false);
    const followUp = assistantReducer(done, { type: 'SPEECH_START' });
    expect(followUp.phase).toBe('hearing');
    expect(followUp.answer).toEqual(answer); // answer stays up until the new one arrives
  });

  it('user mute: the mic is ignored; muting mid-sentence drops it; unmuting listens again', () => {
    const hearing = run({ type: 'SESSION_READY' }, { type: 'SPEECH_START' });
    expect(hearing.phase).toBe('hearing');
    const muted = assistantReducer(hearing, { type: 'SET_MUTED', muted: true });
    expect(muted.userMuted).toBe(true);
    expect(muted.phase).toBe('listening'); // the half sentence is not a question
    expect(isMicMuted(muted)).toBe(true);
    expect(shouldStreamFrames(muted)).toBe(true); // the camera keeps going
    const unmuted = assistantReducer(muted, { type: 'SET_MUTED', muted: false });
    expect(isMicMuted(unmuted)).toBe(false);
  });

  it('pauses frames while an answer is on screen and resumes after dismiss', () => {
    const shown = run({ type: 'SESSION_READY' }, { type: 'TURN_START' }, { type: 'TURN_ANSWERED', answer });
    expect(shouldStreamFrames(shown)).toBe(false);
    expect(shouldStreamFrames(assistantReducer(shown, { type: 'DISMISS' }))).toBe(true);
    expect(shouldStreamFrames(initialAssistantState)).toBe(false);
  });

  it('discarded speech goes back to listening', () => {
    expect(run({ type: 'SESSION_READY' }, { type: 'SPEECH_START' }, { type: 'SPEECH_DISCARDED' }).phase).toBe('listening');
  });

  it('ignored speech shows a notice but no answer', () => {
    const s = run({ type: 'SESSION_READY' }, { type: 'TURN_START' }, { type: 'TURN_IGNORED', transcript: '' });
    expect(s).toMatchObject({ phase: 'listening', answer: null, notice: "I didn't catch that." });
  });

  it('failure -> error -> retry', () => {
    const failed = run({ type: 'SESSION_READY' }, { type: 'TURN_START' }, { type: 'TURN_FAILED', message: 'offline' });
    expect(failed).toMatchObject({ phase: 'error', error: 'offline' });
    expect(canSendTurn(failed)).toBe(true);
    expect(assistantReducer(failed, { type: 'RETRY' })).toMatchObject({ phase: 'listening', error: null });
  });

  it('dismiss hides the answer and stops speaking', () => {
    const s = run(
      { type: 'SESSION_READY' }, { type: 'TURN_START' }, { type: 'TURN_ANSWERED', answer },
      { type: 'SPEAKING', speaking: true }, { type: 'DISMISS' },
    );
    expect(s.answer).toBeNull();
    expect(s.speaking).toBe(false);
  });

  it('a new answer replaces the old one', () => {
    const s = run(
      { type: 'SESSION_READY' }, { type: 'TURN_START' }, { type: 'TURN_ANSWERED', answer },
      { type: 'TURN_START' }, { type: 'TURN_ANSWERED', answer: { ...answer, turnId: 't2' } },
    );
    expect(s.answer?.turnId).toBe('t2');
  });

  it('session failure is an error', () => {
    expect(run({ type: 'SESSION_FAILED', message: 'down' })).toMatchObject({ phase: 'error', error: 'down' });
  });
});

describe('frameAgeLabel', () => {
  it('labels only earlier frames', () => {
    expect(frameAgeLabel(null)).toBeNull();
    expect(frameAgeLabel(2)).toBeNull();
    expect(frameAgeLabel(58.4)).toBe('Seen 58 seconds ago');
    expect(frameAgeLabel(100)).toBe('Seen 2 minutes ago');
    expect(frameAgeLabel(60 * 1.2 + 20)).toBe('Seen 2 minutes ago');
    expect(frameAgeLabel(91)).toBe('Seen 2 minutes ago');
    expect(frameAgeLabel(85)).toBe('Seen 85 seconds ago');
  });
});
