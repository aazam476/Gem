/**
 * All Gem assistant behavior: session (context window), 1 fps frames, always-on mic
 * with end-of-speech detection, prompts, answer display and voice.
 * AssistantScreen only renders what this returns.
 */
import type { CameraView } from 'expo-camera';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';

import { absoluteUrl, api, isSessionGone } from '../api/client';
import type { FrameAck, TurnInput } from '../api/types';
import { FRAME_JPEG_QUALITY, FRAME_LONG_EDGE_PX } from '../config';
import {
  assistantReducer,
  canSendTurn,
  initialAssistantState,
  isMicMuted,
  NOTICE_MS,
  shouldStreamFrames,
  type AssistantState,
} from '../logic/assistantState';
import { pickPictureSize } from '../logic/camera';
import { bytesToBase64, encodeWav } from '../logic/wav';
import { AnswerAudio } from '../services/answerAudio';
import { prepareUpload } from '../services/image';
import { lineText } from '../services/lines';
import type { ActivityState } from '../logic/activity';
import { useActivity } from './useActivity';
import { useFrameStreamer, type FrameStats } from './useFrameStreamer';
import { useSpeechCapture } from './useSpeechCapture';

export interface AssistantController {
  state: AssistantState;
  /** Callback ref for the camera: <CameraView ref={attachCamera} /> */
  attachCamera: (camera: CameraView | null) => void;
  onCameraReady: () => void;
  cameraReady: boolean;
  /** Capture size for <CameraView pictureSize>: ~1080p so frames don't stall the preview. */
  pictureSize: string | undefined;
  micActive: boolean;
  micError: string | null;
  frames: FrameStats;
  /** active → idle (1 min: frames paused) → expired (10 min: context purged). Movement or speech wakes it. */
  activity: ActivityState;
  /** Hide the answer image + text. */
  dismiss: () => void;
  /** Read the current answer aloud again (no new ElevenLabs charge). */
  replay: () => void;
  /** Leave the error state and try again. */
  retry: () => void;
}

export function useAssistant(): AssistantController {
  const [state, dispatch] = useReducer(assistantReducer, initialAssistantState);
  const stateRef = useRef(state);
  const camera = useRef<CameraView | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [pictureSize, setPictureSize] = useState<string | undefined>();
  const [appActive, setAppActive] = useState(AppState.currentState !== 'background');
  const session = useRef<string | null>(null);
  const creating = useRef<Promise<string> | null>(null);
  const audio = useRef<AnswerAudio | null>(null);

  useEffect(() => {
    stateRef.current = state;
  });

  if (audio.current === null) {
    audio.current = new AnswerAudio((speaking) => dispatch({ type: 'SPEAKING', speaking }));
  }

  /** Inactivity timings from the portal, delivered with each session. */
  const [timings, setTimings] = useState<{ idleAfterMs: number; purgeAfterMs: number } | undefined>();

  const ensureSession = useCallback(async (): Promise<string> => {
    if (session.current) return session.current;
    if (!creating.current) {
      creating.current = api
        .createSession()
        .then((s) => {
          session.current = s.session_id;
          if (s.idle_after_s && s.purge_after_s) {
            setTimings({ idleAfterMs: s.idle_after_s * 1000, purgeAfterMs: s.purge_after_s * 1000 });
          }
          return s.session_id;
        })
        .finally(() => {
          creating.current = null;
        });
    }
    return creating.current;
  }, []);

  /** Run a call against the session; if it timed out server-side, open a new one and retry once. */
  const withSession = useCallback(
    async <T,>(fn: (id: string) => Promise<T>): Promise<T> => {
      const id = await ensureSession();
      try {
        return await fn(id);
      } catch (err) {
        if (!isSessionGone(err)) throw err;
        session.current = null;
        return fn(await ensureSession());
      }
    },
    [ensureSession],
  );

  const activity = useActivity(timings);
  const { note, noteFrameChange } = activity;

  const startSession = useCallback(() => {
    ensureSession()
      .then(() => dispatch({ type: 'SESSION_READY' }))
      .catch(() => dispatch({ type: 'SESSION_FAILED', message: lineText('network_error') }));
  }, [ensureSession]);

  useEffect(() => {
    startSession();
    const sub = AppState.addEventListener('change', (s) => setAppActive(s !== 'background'));
    const player = audio.current;
    return () => {
      sub.remove();
      player?.clear();
      const id = session.current;
      session.current = null;
      if (id) void api.endSession(id).catch(() => undefined);
    };
  }, [startSession]);

  // -- frames: 1 per second into the context window ---------------------------------
  const sendFrame = useCallback(async (): Promise<FrameAck | null> => {
    const cam = camera.current;
    if (!cam) return null;
    const shot = await cam.takePictureAsync({ quality: 0.5, shutterSound: false });
    const frame = await prepareUpload(shot, { longEdge: FRAME_LONG_EDGE_PX, quality: FRAME_JPEG_QUALITY });
    const ack = await withSession((id) => api.sendFrame(id, frame.base64));
    noteFrameChange(ack.change_score);
    return ack;
  }, [withSession, noteFrameChange]);

  // Paused while an answer is on screen (the memory keeps what the user was asking about)
  // and after 1 minute of inactivity (no movement, speech or scene change).
  const streaming = cameraReady && appActive && shouldStreamFrames(state) && activity.state === 'active';

  // Transient notices disappear on their own.
  useEffect(() => {
    if (!state.notice) return;
    const t = setTimeout(() => dispatch({ type: 'CLEAR_NOTICE' }), NOTICE_MS);
    return () => clearTimeout(t);
  }, [state.notice]);

  // Gem thinking or talking counts as activity.
  useEffect(() => {
    if (state.phase === 'thinking' || state.speaking) note('busy');
  }, [state.phase, state.speaking, note]);

  // 10 minutes inactive: end the session so its context window (frames, history, audio) is
  // purged now. The next frame or question opens a fresh session automatically.
  useEffect(() => {
    if (activity.state !== 'expired') return;
    const id = session.current;
    session.current = null;
    if (id) void api.endSession(id).catch(() => undefined);
  }, [activity.state]);
  const frames = useFrameStreamer(streaming, sendFrame);

  // -- prompts --------------------------------------------------------------------------
  const submit = useCallback(
    (input: TurnInput) => {
      if (!canSendTurn(stateRef.current)) return;
      stateRef.current = { ...stateRef.current, phase: 'thinking' }; // block re-entry before re-render
      dispatch({ type: 'TURN_START' });
      audio.current?.stop();
      withSession((id) => api.sendTurn(id, input))
        .then((out) => {
          if (out.status === 'ignored') {
            dispatch({ type: 'TURN_IGNORED', transcript: out.transcript });
            return;
          }
          dispatch({
            type: 'TURN_ANSWERED',
            answer: {
              turnId: out.turn_id,
              transcript: out.transcript,
              answer: out.answer,
              imageUri: out.image_url ? absoluteUrl(out.image_url) : null,
              imageWidth: out.image_width,
              imageHeight: out.image_height,
              frameAgeS: out.frame_age_s,
              audioUrl: out.audio_url,
            },
          });
          void audio.current?.play(out.turn_id, out.audio_url, out.answer);
        })
        .catch(() => {
          const message = lineText('network_error');
          dispatch({ type: 'TURN_FAILED', message });
          // Through AnswerAudio so the audio session is switched to play-and-record first
          // (on iOS the idle mic stream holds a record-only session, which would mute speech).
          void audio.current?.play(`line-${Date.now()}`, null, message);
        });
    },
    [withSession],
  );

  const mic = useSpeechCapture({
    enabled: appActive && state.phase !== 'starting',
    muted: isMicMuted(state),
    paused: state.speaking,
    onSpeechStart: () => {
      note('speech');
      dispatch({ type: 'SPEECH_START' });
    },
    onDiscard: () => dispatch({ type: 'SPEECH_DISCARDED' }),
    onUtterance: (pcm, rate) => {
      submit({ audio_base64: bytesToBase64(encodeWav(pcm, rate)), audio_mime: 'audio/wav' });
    },
  });
  // The player moves the mic aside before any audio starts (see AnswerAudio.setBeforePlay).
  const { standBy } = mic;
  useEffect(() => {
    audio.current?.setBeforePlay(standBy);
  }, [standBy]);

  return {
    state,
    attachCamera: useCallback((c: CameraView | null) => {
      camera.current = c;
    }, []),
    onCameraReady: () => {
      setCameraReady(true);
      const cam = camera.current;
      if (!cam || Platform.OS === 'web' || pictureSize) return;
      Promise.resolve()
        .then(() => cam.getAvailablePictureSizesAsync())
        .then((sizes) => {
          const size = pickPictureSize(sizes);
          if (size) setPictureSize(size);
        })
        .catch(() => undefined); // keep the default size
    },
    cameraReady,
    pictureSize,
    micActive: mic.active,
    micError: mic.error,
    frames,
    activity: activity.state,
    dismiss: () => {
      note('interaction');
      audio.current?.stop();
      dispatch({ type: 'DISMISS' });
    },
    replay: () => {
      note('interaction');
      const a = stateRef.current.answer;
      if (a) void audio.current?.play(a.turnId, a.audioUrl, a.answer);
    },
    retry: () => {
      note('interaction');
      dispatch({ type: 'RETRY' });
      if (!session.current) startSession();
    },
  };
}
