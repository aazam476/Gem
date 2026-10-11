/**
 * All Gem assistant behavior: session (context window), 1 fps frames, always-on mic
 * with end-of-speech detection, prompts, answer display and voice.
 * AssistantScreen only renders what this returns.
 */
import type { CameraView } from 'expo-camera';
import * as Speech from 'expo-speech';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { absoluteUrl, api, isSessionGone } from '../api/client';
import type { FrameAck, TurnInput } from '../api/types';
import { FRAME_JPEG_QUALITY, FRAME_LONG_EDGE_PX } from '../config';
import {
  assistantReducer,
  canSendTurn,
  initialAssistantState,
  isMicMuted,
  type AssistantState,
} from '../logic/assistantState';
import { bytesToBase64, encodeWav } from '../logic/wav';
import { AnswerAudio } from '../services/answerAudio';
import { prepareUpload } from '../services/image';
import { lineText } from '../services/lines';
import { useFrameStreamer, type FrameStats } from './useFrameStreamer';
import { useSpeechCapture } from './useSpeechCapture';

export interface AssistantController {
  state: AssistantState;
  /** Callback ref for the camera: <CameraView ref={attachCamera} /> */
  attachCamera: (camera: CameraView | null) => void;
  onCameraReady: () => void;
  cameraReady: boolean;
  micActive: boolean;
  micError: string | null;
  frames: FrameStats;
  /** Hide the answer image + text. */
  dismiss: () => void;
  /** Read the current answer aloud again (no new ElevenLabs charge). */
  replay: () => void;
  /** Leave the error state and try again. */
  retry: () => void;
  /** Typed alternative to speaking. */
  sendText: (text: string) => void;
}

export function useAssistant(): AssistantController {
  const [state, dispatch] = useReducer(assistantReducer, initialAssistantState);
  const stateRef = useRef(state);
  const camera = useRef<CameraView | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
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

  const ensureSession = useCallback(async (): Promise<string> => {
    if (session.current) return session.current;
    if (!creating.current) {
      creating.current = api
        .createSession()
        .then((s) => {
          session.current = s.session_id;
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
    return withSession((id) => api.sendFrame(id, frame.base64));
  }, [withSession]);

  const streaming = cameraReady && appActive && state.phase !== 'starting' && state.phase !== 'error';
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
          Speech.speak(message, { language: 'en-US' });
        });
    },
    [withSession],
  );

  const mic = useSpeechCapture({
    enabled: appActive && state.phase !== 'starting',
    muted: isMicMuted(state),
    onSpeechStart: () => dispatch({ type: 'SPEECH_START' }),
    onDiscard: () => dispatch({ type: 'SPEECH_DISCARDED' }),
    onUtterance: (pcm, rate) =>
      submit({ audio_base64: bytesToBase64(encodeWav(pcm, rate)), audio_mime: 'audio/wav' }),
  });

  return {
    state,
    attachCamera: useCallback((c: CameraView | null) => {
      camera.current = c;
    }, []),
    onCameraReady: () => setCameraReady(true),
    cameraReady,
    micActive: mic.active,
    micError: mic.error,
    frames,
    dismiss: () => {
      audio.current?.stop();
      dispatch({ type: 'DISMISS' });
    },
    replay: () => {
      const a = stateRef.current.answer;
      if (a) void audio.current?.play(a.turnId, a.audioUrl, a.answer);
    },
    retry: () => {
      dispatch({ type: 'RETRY' });
      if (!session.current) startSession();
    },
    sendText: (text: string) => {
      if (text.trim()) submit({ text: text.trim() });
    },
  };
}
